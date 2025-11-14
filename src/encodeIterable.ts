import { Encoder } from "./Encoder.js"
import type { CBORValue } from "./types.js"
import type { EncodeOptions } from "./options.js"
import type { Flatten, WithRequired, NoInfer } from "./utils.js"

/** Encode an iterable of CBOR values into an iterable of Uint8Array chunks */
export function encodeIterable<T extends CBORValue>(
  source: Iterable<T>,
  options?: EncodeOptions
): IterableIterator<Uint8Array>

export function encodeIterable<T>(
  source: Iterable<T>,
  options: WithRequired<EncodeOptions<Flatten<NoInfer<T>>>, "onValue">
): IterableIterator<Uint8Array>

export function* encodeIterable(
	source: Iterable<CBORValue>,
	options: EncodeOptions = {},
): IterableIterator<Uint8Array> {
	const encoder = new Encoder(options)
	for (const value of source) {
		yield* encoder.encodeValue(value)
	}

	yield* encoder.flush()
}
