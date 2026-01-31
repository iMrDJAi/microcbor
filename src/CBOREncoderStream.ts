import { Encoder } from "./Encoder.js"
import { createTransformWithBackpressure } from "./utils.js"
import type { CBORValue } from "./types.js"
import type { EncodeOptions } from "./options.js"
import type { Flatten, WithRequired, NoInfer } from "./utils.js"

/**
 * Encode a Web Streams API ReadableStream.
 * options.chunkRecycling has no effect here.
 */
export class CBOREncoderStream<T = CBORValue> {
	readable!: ReadableStream<Uint8Array>
	writable!: WritableStream<T>

	constructor(...[options = {}]: T extends CBORValue
		? []|[EncodeOptions]
		: [WithRequired<EncodeOptions<Flatten<NoInfer<T>>>, "onValue">]
	) {
		const encoder = new Encoder({ ...options, chunkRecycling: false } as EncodeOptions)

		return createTransformWithBackpressure<T, Uint8Array>(
			async (value, enqueue) => {
				// Encode the incoming value and push all resulting chunks
				for (const chunk of encoder.encodeValue(value as CBORValue)) {
					await enqueue(chunk)
				}
			},
			async (enqueue) => {
				// Flush any remaining chunks
				for (const chunk of encoder.flush()) {
					await enqueue(chunk)
				}
			}
		)
	}
}
