import { getFloat16 } from "fp16"

import type { CBORValue, CBORArray, CBORMap } from "./types.js"
import type { DecodeOptions, FloatSize } from "./options.js"
import type { WithRequired, Flatten, NoInfer } from "./utils.js"
import { UnsafeIntegerError, maxSafeInteger, minSafeInteger } from "./utils.js"

export class Decoder<T = CBORValue> implements IterableIterator<T> {
	public readonly allowUndefined: boolean
	public readonly minFloatSize: (typeof FloatSize)[keyof typeof FloatSize]

	private offset = 0
	private byteLength = 0
	private readonly decoder = new TextDecoder()
	private readonly chunks: Uint8Array[] = []
	private readonly constantBuffer = new ArrayBuffer(8)
	private readonly constantView = new DataView(this.constantBuffer)
	private readonly iter: Iterator<Uint8Array, void, undefined>
	private readonly onKey?: (decodeKey: () => string, length: number) => string|void
	private readonly onValue?: (
		decodeValue: () => CBORValue,
		length: number,
		type: string,
		keyPath: (string|number)[]
	) => CBORValue|void
	private env: {
		isKey: boolean
		keyPath: (string|number)[]
	} = { isKey: false, keyPath: [] }

	public constructor(...[source, options = {}]: T extends CBORValue
		? ([Iterable<Uint8Array>]|[Iterable<Uint8Array>, DecodeOptions])
		: [Iterable<Uint8Array>, WithRequired<DecodeOptions<Flatten<NoInfer<T>>>, "onValue">]
	) {
		this.allowUndefined = options.allowUndefined ?? true
		this.minFloatSize = options.minFloatSize ?? 16
		this.iter = source[Symbol.iterator]()
		this.onKey = options.onKey
		this.onValue = (options as DecodeOptions).onValue
	}

	[Symbol.iterator] = () => this

	private allocate(size: number) {
		while (this.byteLength < size) {
			const { done, value } = this.iter.next()
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
		return () => {
			this.allocate(size)
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

	private decodeBytes(length: number): Uint8Array {
		this.allocate(length)
		const array = new Uint8Array(length)
		this.fill(array)
		return array
	}

	private decodeString(length: number): string {
		this.allocate(length)
		const data = new Uint8Array(length)
		this.fill(data)
		return this.decoder.decode(data)
	}

	private getArgument(additionalInformation: number): {
		value: number
		uint64?: bigint
		size: number
	} {
		if (additionalInformation < 24) {
			return { value: additionalInformation, size: 1 }
		} else if (additionalInformation === 24) {
			return { value: this.uint8(), size: 1 }
		} else if (additionalInformation === 25) {
			return { value: this.uint16(), size: 2 }
		} else if (additionalInformation === 26) {
			return { value: this.uint32(), size: 4 }
		} else if (additionalInformation === 27) {
			const uint64 = this.uint64()
			const value = maxSafeInteger < uint64 ? Infinity : Number(uint64)
			return { value, uint64, size: 8 }
		} else if (additionalInformation === 31) {
			throw new Error("microcbor does not support decoding indefinite-length items")
		} else {
			throw new Error("invalid argument encoding")
		}
	}

	public next(): { done: true; value: undefined } | { done: false; value: T } {
		while (this.byteLength === 0) {
			const { done, value } = this.iter.next()
			if (done) {
				return { done: true, value: undefined }
			} else if (value.byteLength > 0) {
				this.chunks.push(value)
				this.byteLength += value.byteLength
			}
		}

		const value = this.decodeValue()
		return { done: false, value: value as T }
	}

	private decodeValue(): CBORValue {
		const initialByte = this.uint8()
		const majorType = initialByte >> 5
		const additionalInformation = initialByte & 0x1f
		const { isKey, keyPath } = this.env

		if (majorType === 0) {
			const { value, uint64, size } = this.getArgument(additionalInformation)
			if (uint64 !== undefined && maxSafeInteger < uint64) {
				throw new UnsafeIntegerError("cannot decode integers greater than 2^53-1", uint64)
			}
			const val = this.onValue?.(() => value, size, "number", keyPath)
			return val === undefined ? value : val
		} else if (majorType === 1) {
			const { value, uint64, size } = this.getArgument(additionalInformation)
			if (uint64 !== undefined && -1n - uint64 < minSafeInteger) {
				throw new UnsafeIntegerError("cannot decode integers less than -2^53+1", -1n - uint64)
			}
			const val = this.onValue?.(() => (-1 - value), size, "number", keyPath)
			return val === undefined ? (-1 - value) : val
		} else if (majorType === 2) {
			const { value: length } = this.getArgument(additionalInformation)
			let value: CBORValue
			const callback = () => (
				value = (value === undefined ? this.decodeBytes(length) : value) as Uint8Array
			)
			const val = this.onValue?.(callback, length, "Uint8Array", keyPath)
			if (val !== undefined) {
				if (value !== undefined) return val
				this.allocate(length)
				this.advance(length)
				return val
			}
			return callback()
		} else if (majorType === 3) {
			const { value: length } = this.getArgument(additionalInformation)
			let value: CBORValue, val
			const callback = () => (
				value = (value === undefined ? this.decodeString(length) : value) as string
			)
			if (isKey) val = this.onKey?.(callback, length)
			else val = this.onValue?.(callback, length, "string", keyPath)
			if (val !== undefined) {
				if (value !== undefined) return val
				this.allocate(length)
				this.advance(length)
				return val
			}
			return callback()
		} else if (majorType === 4) {
			const { value: length } = this.getArgument(additionalInformation)
			let value: CBORValue
			const callback = () => {
				if (value !== undefined) return value as CBORArray
				value = new Array(length)
				for (let i = 0; i < length; i++) {
					this.pushKey(i)
					value[i] = this.decodeValue()
					this.popKey()
				}
				return value
			}
			const val = this.onValue?.(callback, length, "array", keyPath)
			if (val !== undefined) {
				if (value !== undefined) return val
				for (let i = 0; i < length; i++) this.skipValue()
				return val
			}
			return callback()
		} else if (majorType === 5) {
			const { value: length } = this.getArgument(additionalInformation)
			let value: CBORValue|void
			const callback = () => {
				if (value !== undefined) return value as CBORMap
				value = {}
				for (let i = 0; i < length; i++) {
					this.env.isKey = true
					const key = this.decodeValue()
					this.env.isKey = false
					if (typeof key !== "string") {
						throw new Error("microcbor only supports string keys in objects")
					}
					this.pushKey(key)
					value[key] = this.decodeValue()
					this.popKey()
				}
				return value
			}
			const val = this.onValue?.(callback, length, "object", keyPath)
			if (val !== undefined) {
				if (value !== undefined) return val
				for (let i = 0; i < length * 2; i++) this.skipValue()
				return val
			}
			return callback()
		} else if (majorType === 6) {
			throw new Error("microcbor does not support tagged data items")
		} else if (majorType === 7) {
			let val
			switch (additionalInformation) {
				case 20:
					val = this.onValue?.(() => false, 1, "boolean", keyPath)
					return val === undefined ? false : val
				case 21:
					val = this.onValue?.(() => true, 1, "boolean", keyPath)
					return val === undefined ? true : val
				case 22:
					val = this.onValue?.(() => null, 1, "null", keyPath)
					return val === undefined ? null : val
				case 23:
					if (!this.allowUndefined) throw new TypeError("`undefined` not allowed")
					return this.onValue?.(() => undefined, 1, "undefined", keyPath) as CBORValue
				case 24:
					throw new Error("microcbor does not support decoding unassigned simple values")
				case 25:
					if (this.minFloatSize <= 16) {
						const value = this.float16()
						val = this.onValue?.(() => value, 2, "number", keyPath)
						return val === undefined ? value : val
					} else {
						throw new Error("cannot decode float16 type - below provided minFloatSize")
					}
				case 26:
					if (this.minFloatSize <= 32) {
						const value = this.float32()
						val = this.onValue?.(() => value, 4, "number", keyPath)
						return val === undefined ? value : val
					} else {
						throw new Error("cannot decode float32 type - below provided minFloatSize")
					}
				case 27:
					const value = this.float64()
					val = this.onValue?.(() => value, 8, "number", keyPath)
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

	private skipValue() {
		const initialByte = this.uint8()
		const majorType = initialByte >> 5
		const additionalInformation = initialByte & 0x1f

		if (majorType === 0 || majorType === 1) {
			this.getArgument(additionalInformation)
		} else if (majorType === 2 || majorType === 3) {
			const { value: length } = this.getArgument(additionalInformation)
			this.allocate(length)
			this.advance(length)
		} else if (majorType === 4) {
			const { value: length } = this.getArgument(additionalInformation)
			for (let i = 0; i < length; i++) this.skipValue()
		} else if (majorType === 5) {
			const { value: length } = this.getArgument(additionalInformation)
			for (let i = 0; i < length * 2; i++) this.skipValue()
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
					this.allocate(2)
					this.advance(2)
					break
				case 26:
					this.allocate(4)
					this.advance(4)
					break
				case 27:
					this.allocate(8)
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

/**
 * Decode an iterable of Uint8Array chunks into an iterable of CBOR values
 * @param source Iterable of Uint8Array chunks
 * @param options Decode options
 */
export function* decodeIterable<T = CBORValue>(...args: T extends CBORValue
	? ([Iterable<Uint8Array>]|[Iterable<Uint8Array>, DecodeOptions])
	: [Iterable<Uint8Array>, WithRequired<DecodeOptions<Flatten<NoInfer<T>>>, "onValue">]
): IterableIterator<T> {
	yield* new Decoder<T>(...args)
}
