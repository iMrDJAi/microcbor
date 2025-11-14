import { Encoder } from "./Encoder.js"
import type { CBORValue } from "./types.js"
import type { EncodeOptions } from "./options.js"
import type { Flatten, WithRequired, NoInfer } from "./utils.js"

/** Encode an async iterable of CBOR values into an async iterable of Uint8Array chunks */
export function encodeAsyncIterable<T extends CBORValue>(
	source: AsyncIterable<T>,
	options?: EncodeOptions
): AsyncIterableIterator<Uint8Array>

export function encodeAsyncIterable<T>(
	source: AsyncIterable<T>,
	options: WithRequired<EncodeOptions<Flatten<NoInfer<T>>>, "onValue">
): AsyncIterableIterator<Uint8Array>

export async function* encodeAsyncIterable(
	source: AsyncIterable<CBORValue>,
	options: EncodeOptions = {},
): AsyncIterableIterator<Uint8Array> {
	const encoder = new Encoder(options)
	for await (const value of source) {
		yield* encoder.encodeValue(value)
	}

	yield* encoder.flush()
}
