import type { CBORValue } from "./types.js"

export const FloatSize = {
	f16: 16,
	f32: 32,
	f64: 64,
}

export interface EncodeOptions<T = CBORValue> {
	/**
	 * Allow `undefined`
	 * @default true
	 */
	allowUndefined?: boolean

	/**
	 * Re-use the same underlying ArrayBuffer for all yielded chunks.
	 * If this is enabled, the consumer must copy each chunk content
	 * themselves to a new buffer if they wish to keep it.
	 * This mode is useful for efficiently hashing objects without
	 * ever allocating memory for the entire encoded result.
	 * @default false
	 */
	chunkRecycling?: boolean

	/**
	 * Maximum chunk size
	 * @default 4096
	 */
	chunkSize?: number

	/**
	 * Minimum bitsize for floating-point numbers: 16, 32, or 64
	 * @default 16
	 */
	minFloatSize?: (typeof FloatSize)[keyof typeof FloatSize]

	/**
	 * Function to remap/validate object keys while encoding
	 * @param key Original object key
	 * @throws Error if key is invalid
	 * @returns An optional replacement key string
	 */
	onKey?: (key: string) => string|void

	/**
	 * Function to validate/transform/replace values while encoding
	 * @param value Value to validate/transform/replace
	 * @param keyPath Array of keys describing the access path to this value
	 * @throws Error if value is invalid
	 * @returns An optional replacement value to use
	 */
	onValue?: (value: T, keyPath: (string|number)[]) => CBORValue|void
}

export interface DecodeOptions<T = CBORValue> {
	/**
	 * Allow `undefined`
	 * @default true
	 */
	allowUndefined?: boolean

	/**
	 * Minimum bitsize for floating-point numbers: 16, 32, or 64
	 * @default 16
	 */
	minFloatSize?: (typeof FloatSize)[keyof typeof FloatSize]

	/**
	 * Function to remap/validate object keys while decoding
	 * @param decodeKey Function to decode original object key
	 * @param length Key length to validate pre-decoding
	 * @throws Error if length/key is invalid
	 * @returns An optional replacement key string
	 */
	onKey?: (decodeKey: () => string, length: number) => string|void

	/**
	 * Function to validate/transform/replace values while decoding
	 * @param decodeValue Function to decode value
	 * @param length Value length/size to validate pre-decoding
	 * @param type Value type (e.g. 'number', 'string', 'Uint8Array'...)
	 * @param keyPath Array of keys describing the access path to this value
	 * @throws Error if length/value is invalid
	 * @returns An optional replacement value to use
	 */
	onValue?: (
		decodeValue: () => CBORValue,
		length: number,
		type: string,
		keyPath: (string|number)[]
	) => T|void
}
