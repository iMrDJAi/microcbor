import { getFloat16 } from "fp16"

import type { CBORValue, CBORArray, CBORMap } from "./types.js"
import type { DecodeOptions, FloatSize } from "./options.js"
import type { WithRequired, Flatten, NoInfer } from "./utils.js"
import { UnsafeIntegerError, maxSafeInteger, minSafeInteger } from "./utils.js"

export class Decoder<T = CBORValue> {
	public readonly allowUndefined: boolean
	public readonly minFloatSize: (typeof FloatSize)[keyof typeof FloatSize]

	private readonly decoder = new TextDecoder()
	private readonly onKey?: (decodeKey: () => string, length: number) => string|void
	private readonly onValue?: (
		decodeValue: () => CBORValue,
		length: number,
		type: string,
		keyPath: (string|number)[]
	) => CBORValue|void

	private data: Uint8Array
	#offset: number
	#view: DataView
	#env: {
		isKey: boolean
		keyPath: (string|number)[]
	}

	public constructor(...[data, options = {}]: T extends CBORValue
		? ([Uint8Array]|[Uint8Array, DecodeOptions])
		: [Uint8Array, WithRequired<DecodeOptions<Flatten<NoInfer<T>>>, "onValue">]
	) {
		this.data = data
		this.#offset = 0
		this.#view = new DataView(data.buffer, data.byteOffset, data.byteLength)
		this.#env = { isKey: false, keyPath: [] }
		this.allowUndefined = options.allowUndefined ?? true
		this.minFloatSize = options.minFloatSize ?? 16
		this.onKey = options.onKey
		this.onValue = (options as DecodeOptions).onValue
	}

	public getOffset(): number {
		return this.#offset
	}

	private pushKey(key: string|number) {
		this.#env.keyPath.push(key)
	}

	private popKey() {
		this.#env.keyPath.pop()
	}

	private constant =
		<T>(size: number, f: () => T) =>
		() => {
			const value = f()
			this.#offset += size
			return value
		}

	private float16 = this.constant(2, () => getFloat16(this.#view, this.#offset))
	private float32 = this.constant(4, () => this.#view.getFloat32(this.#offset))
	private float64 = this.constant(8, () => this.#view.getFloat64(this.#offset))
	private uint8 = this.constant(1, () => this.#view.getUint8(this.#offset))
	private uint16 = this.constant(2, () => this.#view.getUint16(this.#offset))
	private uint32 = this.constant(4, () => this.#view.getUint32(this.#offset))
	private uint64 = this.constant(8, () => this.#view.getBigUint64(this.#offset))

	private decodeBytes(length: number): Uint8Array {
		const value = new Uint8Array(length)
		value.set(this.data.subarray(this.#offset, this.#offset + length), 0)
		this.#offset += length
		return value
	}

	private decodeString(length: number): string {
		const value = this.decoder.decode(this.data.subarray(this.#offset, this.#offset + length))
		this.#offset += length
		return value
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

	public decodeValue<R = T>(): R
	public decodeValue(): CBORValue {
		const initialByte = this.uint8()
		const majorType = initialByte >> 5
		const additionalInformation = initialByte & 0x1f
		const { isKey, keyPath } = this.#env

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
				if (value === undefined) this.#offset += length
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
				if (value === undefined) this.#offset += length
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
					this.#env.isKey = true
					const key = this.decodeValue()
					this.#env.isKey = false
					if (typeof key !== "string") {
						throw new Error("microcbor only supports string keys in objects")
					}
					if (key in value) {
						throw new Error("duplicate object key")
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
      this.#offset += length
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
          this.#offset += 2
          break
        case 26:
          this.#offset += 4
          break
        case 27:
          this.#offset += 8
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
 * Decode a single CBOR value
 * @param data Data to decode
 * @param options Decode options
 */
export function decode<T = CBORValue>(...[data, options]: T extends CBORValue
	? ([Uint8Array]|[Uint8Array, DecodeOptions])
	: [Uint8Array, WithRequired<DecodeOptions<Flatten<NoInfer<T>>>, "onValue">]
) {
	return new Decoder(data, options as DecodeOptions).decodeValue() as T
}
