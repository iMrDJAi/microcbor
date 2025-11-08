import { getFloat16 } from "fp16"

import type { CBORValue, CBORArray, CBORMap } from "./types.js"

import { UnsafeIntegerError, maxSafeInteger, minSafeInteger } from "./utils.js"
import { DecodeOptions, FloatSize } from "./options.js"

type Awaitable<T> = T | PromiseLike<T>

export interface AsyncDecodeOptions extends Omit<DecodeOptions, 'onKey'|'onValue'> {
	/**
	 * Function to remap/validate object keys while decoding
	 * (async version that works with AsyncIterable and streams)
	 * @param decodeKey Function to decode original object key (async)
	 * @param length Key length to validate pre-decoding
	 * @throws Error if length/key is invalid
	 * @returns An optional replacement key string
	 */
	onKey?: (
		decodeKey: () => Awaitable<string>,
		length: number
	) => Promise<string|void>

	/**
	 * Function to validate/transform/replace values while decoding
	 * (async version that works with AsyncIterable and streams)
	 * @param decodeValue Function to decode value (async)
	 * @param length Value length/size to validate pre-decoding
	 * @param type Value type (e.g. 'number', 'string', 'Uint8Array'...)
	 * @param keyPath Array of keys describing the access path to this value
	 * @throws Error if length/value is invalid
	 * @returns An optional replacement value to use
	 */
	onValue?: (
		decodeValue: () => Awaitable<CBORValue>,
		length: number,
		type: string,
		keyPath: (string|number)[]
	) => Promise<CBORValue|void>

	onFree?: (chunk: Uint8Array) => void
}

export class Decoder<T extends CBORValue = CBORValue> implements AsyncIterableIterator<T> {
	public readonly allowUndefined: boolean
	public readonly minFloatSize: (typeof FloatSize)[keyof typeof FloatSize]

	private offset = 0
	private byteLength = 0
	private readonly decoder = new TextDecoder()
	private readonly chunks: Uint8Array[] = []
	private readonly constantBuffer = new ArrayBuffer(8)
	private readonly constantView = new DataView(this.constantBuffer)
	private readonly iter: AsyncIterator<Uint8Array, void, undefined>
	private readonly onFree?: (chunk: Uint8Array) => void
	private readonly onKey?: (
		decodeKey: () => Awaitable<string>,
		length: number
	) => Promise<string|void>
	private readonly onValue?: (
		decodeValue: () => Awaitable<CBORValue>,
		length: number,
		type: string,
		keyPath: (string|number)[]
	) => Promise<CBORValue|void>
	private env: {
		isKey: boolean
		keyPath: (string|number)[]
	} = { isKey: false, keyPath: [] }

	public constructor(source: AsyncIterable<Uint8Array>, options: AsyncDecodeOptions = {}) {
		this.onFree = options.onFree
		this.allowUndefined = options.allowUndefined ?? true
		this.minFloatSize = options.minFloatSize ?? 16
		this.iter = source[Symbol.asyncIterator]()
		this.onKey = options.onKey
		this.onValue = options.onValue
	}

	[Symbol.asyncIterator] = () => this

	private async allocate(size: number) {
		while (this.byteLength < size) {
			const { done, value } = await this.iter.next()
			if (done) {
				throw new Error("stream ended prematurely")
			} else {
				this.chunks.push(value)
				this.byteLength += value.byteLength
			}
		}
	}

	private advance(length: number, target?: Uint8Array) {
		if (this.byteLength < length) {
			throw new Error("internal error - please file a bug report!")
		}

		let byteLength = 0
		let deleteCount = 0
		for (let i = 0; byteLength < length; i++) {
			const chunk = this.chunks[i]
			const capacity = length - byteLength
			const available = chunk.byteLength - this.offset
			if (available <= capacity) {
				// copy the entire remainder of the chunk
				target?.set(chunk.subarray(this.offset), byteLength)
				byteLength += available
				deleteCount += 1
				this.offset = 0
				this.byteLength -= available
			} else {
				// fill the remainder of the target
				target?.set(chunk.subarray(this.offset, this.offset + capacity), byteLength)

				byteLength += capacity // equivalent to break
				this.offset += capacity
				this.byteLength -= capacity
			}
		}

		if (this.onFree !== undefined) {
			for (let i = 0; i < deleteCount; i++) {
				this.onFree(this.chunks[i])
			}
		}

		this.chunks.splice(0, deleteCount)
	}

	private fill(target: Uint8Array) {
		this.advance(target.byteLength, target)
	}

	private pushKey(key: string|number) {
		this.env.keyPath.push(key)
	}

	private popKey() {
		this.env.keyPath.pop()
	}

	private constant = <T>(size: number, f: (view: DataView) => T) => {
		return async () => {
			await this.allocate(size)
			const array = new Uint8Array(this.constantBuffer, 0, size)
			this.fill(array)
			return f(this.constantView)
		}
	}

	private float16 = this.constant(2, (view) => getFloat16(view, 0))
	private float32 = this.constant(4, (view) => view.getFloat32(0))
	private float64 = this.constant(8, (view) => view.getFloat64(0))
	private uint8 = this.constant(1, (view) => view.getUint8(0))
	private uint16 = this.constant(2, (view) => view.getUint16(0))
	private uint32 = this.constant(4, (view) => view.getUint32(0))
	private uint64 = this.constant(8, (view) => view.getBigUint64(0))

	private async decodeBytes(length: number): Promise<Uint8Array> {
		await this.allocate(length)
		const array = new Uint8Array(length)
		this.fill(array)
		return array
	}

	private async decodeString(length: number): Promise<string> {
		await this.allocate(length)
		const data = new Uint8Array(length)
		this.fill(data)
		return this.decoder.decode(data)
	}

	private async getArgument(additionalInformation: number): Promise<{
		value: number
		uint64?: bigint
		size: number
	}> {
		if (additionalInformation < 24) {
			return { value: additionalInformation, size: 1 }
		} else if (additionalInformation === 24) {
			return { value: await this.uint8(), size: 1 }
		} else if (additionalInformation === 25) {
			return { value: await this.uint16(), size: 2 }
		} else if (additionalInformation === 26) {
			return { value: await this.uint32(), size: 4 }
		} else if (additionalInformation === 27) {
			const uint64 = await this.uint64()
			const value = maxSafeInteger < uint64 ? Infinity : Number(uint64)
			return { value, uint64, size: 8 }
		} else if (additionalInformation === 31) {
			throw new Error("microcbor does not support decoding indefinite-length items")
		} else {
			throw new Error("invalid argument encoding")
		}
	}

	public async next(): Promise<{ done: true; value: undefined } | { done: false; value: T }> {
		while (this.byteLength === 0) {
			const { done, value } = await this.iter.next()
			if (done) {
				return { done: true, value: undefined }
			} else if (value.byteLength > 0) {
				this.chunks.push(value)
				this.byteLength += value.byteLength
			}
		}

		const value = await this.decodeValue()
		return { done: false, value: value as T }
	}

	private async decodeValue(): Promise<CBORValue> {
		const initialByte = await this.uint8()
		const majorType = initialByte >> 5
		const additionalInformation = initialByte & 0x1f
		const { isKey, keyPath } = this.env

		if (majorType === 0) {
			const { value, uint64, size } = await this.getArgument(additionalInformation)
			if (uint64 !== undefined && maxSafeInteger < uint64) {
				throw new UnsafeIntegerError("cannot decode integers greater than 2^53-1", uint64)
			}
			const val = await this.onValue?.(() => value, size, "number", keyPath)
			return val === undefined ? value : val
		} else if (majorType === 1) {
			const { value, uint64, size } = await this.getArgument(additionalInformation)
			if (uint64 !== undefined && -1n - uint64 < minSafeInteger) {
				throw new UnsafeIntegerError("cannot decode integers less than -2^53+1", -1n - uint64)
			}
			const val = await this.onValue?.(() => (-1 - value), size, "number", keyPath)
			return val === undefined ? (-1 - value) : val
		} else if (majorType === 2) {
			const { value: length } = await this.getArgument(additionalInformation)
			let value: CBORValue
			const callback = async () => (
				value = (value === undefined ? await this.decodeBytes(length) : value) as Uint8Array
			)
			const val = await this.onValue?.(callback, length, "Uint8Array", keyPath)
			if (val !== undefined) {
				if (value !== undefined) return val
				await this.allocate(length)
				this.advance(length)
				return val
			}
			return callback()
		} else if (majorType === 3) {
			const { value: length } = await this.getArgument(additionalInformation)
			let value: CBORValue, val
			const callback = async () => (
				value = (value === undefined ? await this.decodeString(length) : value) as string
			)
			if (isKey) val = await this.onKey?.(callback, length)
			else val = await this.onValue?.(callback, length, "string", keyPath)
			if (val !== undefined) {
				if (value !== undefined) return val
				await this.allocate(length)
				this.advance(length)
				return val
			}
			return callback()
		} else if (majorType === 4) {
			const { value: length } = await this.getArgument(additionalInformation)
			let value: CBORValue
			const callback = async () => {
				if (value !== undefined) return value as CBORArray
				value = new Array(length)
				for (let i = 0; i < length; i++) {
					this.pushKey(i)
					value[i] = await this.decodeValue()
					this.popKey()
				}
				return value
			}
			const val = await this.onValue?.(callback, length, "array", keyPath)
			if (val !== undefined) {
				if (value !== undefined) return val
				for (let i = 0; i < length; i++) await this.skipValue()
				return val
			}
			return callback()
		} else if (majorType === 5) {
			const { value: length } = await this.getArgument(additionalInformation)
			let value: CBORValue|void
			const callback = async () => {
				if (value !== undefined) return value as CBORMap
				value = {}
				for (let i = 0; i < length; i++) {
					this.env.isKey = true
					const key = await this.decodeValue()
					this.env.isKey = false
					if (typeof key !== "string") {
						throw new Error("microcbor only supports string keys in objects")
					}
					this.pushKey(key)
					value[key] = await this.decodeValue()
					this.popKey()
				}
				return value
			}
			const val = await this.onValue?.(callback, length, "object", keyPath)
			if (val !== undefined) {
				if (value !== undefined) return val
				for (let i = 0; i < length * 2; i++) await this.skipValue()
				return val
			}
			return callback()
		} else if (majorType === 6) {
			throw new Error("microcbor does not support tagged data items")
		} else if (majorType === 7) {
			let val
			switch (additionalInformation) {
				case 20:
					val = await this.onValue?.(() => false, 1, "boolean", keyPath)
					return val === undefined ? false : val
				case 21:
					val = await this.onValue?.(() => true, 1, "boolean", keyPath)
					return val === undefined ? true : val
				case 22:
					val = await this.onValue?.(() => null, 1, "null", keyPath)
					return val === undefined ? null : val
				case 23:
					if (!this.allowUndefined) throw new TypeError("`undefined` not allowed")
					return await this.onValue?.(() => undefined, 1, "undefined", keyPath) as CBORValue
				case 24:
					throw new Error("microcbor does not support decoding unassigned simple values")
				case 25:
					if (this.minFloatSize <= 16) {
						const value = await this.float16()
						val = await this.onValue?.(() => value, 2, "number", keyPath)
						return val === undefined ? value : val
					} else {
						throw new Error("cannot decode float16 type - below provided minFloatSize")
					}
				case 26:
					if (this.minFloatSize <= 32) {
						const value = await this.float32()
						val = await this.onValue?.(() => value, 4, "number", keyPath)
						return val === undefined ? value : val
					} else {
						throw new Error("cannot decode float32 type - below provided minFloatSize")
					}
				case 27:
					const value = await this.float64()
					val = await this.onValue?.(() => value, 8, "number", keyPath)
					return val === undefined ? value : val
				case 31:
					throw new Error("microcbor does not support decoding indefinite-length items")
				default:
					throw new Error("invalid simple value")
			}
		} else {
			throw new Error("invalid major type")
		}
	}

	private async skipValue() {
		const initialByte = await this.uint8()
		const majorType = initialByte >> 5
		const additionalInformation = initialByte & 0x1f

		if (majorType === 0 || majorType === 1) {
			await this.getArgument(additionalInformation)
		} else if (majorType === 2 || majorType === 3) {
			const { value: length } = await this.getArgument(additionalInformation)
			await this.allocate(length)
			this.advance(length)
		} else if (majorType === 4) {
			const { value: length } = await this.getArgument(additionalInformation)
			for (let i = 0; i < length; i++) await this.skipValue()
		} else if (majorType === 5) {
			const { value: length } = await this.getArgument(additionalInformation)
			for (let i = 0; i < length * 2; i++) await this.skipValue()
		} else if (majorType === 6) {
			throw new Error("microcbor does not support tagged data items")
		} else if (majorType === 7) {
			switch (additionalInformation) {
				case 20: case 21: case 22:
					break
				case 23:
					if (!this.allowUndefined) throw new TypeError("`undefined` not allowed")
					break
				case 24:
					throw new Error("microcbor does not support decoding unassigned simple values")
				case 25:
					await this.allocate(2)
					this.advance(2)
					break
				case 26:
					await this.allocate(4)
					this.advance(4)
					break
				case 27:
					await this.allocate(8)
					this.advance(8)
					break
				case 31:
					throw new Error("microcbor does not support decoding indefinite-length items")
				default:
					throw new Error("invalid simple value")
			}
		}
	}
}

/** Decode an async iterable of Uint8Array chunks into an async iterable of CBOR values */
export async function* decodeAsyncIterable(
	source: AsyncIterable<Uint8Array>,
	options: AsyncDecodeOptions = {},
): AsyncIterableIterator<CBORValue> {
	yield* new Decoder(source, options)
}
