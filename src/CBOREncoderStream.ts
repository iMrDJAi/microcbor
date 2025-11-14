import { Encoder } from "./Encoder.js"
import type { CBORValue } from "./types.js"
import type { EncodeOptions } from "./options.js"
import type { Flatten, WithRequired, NoInfer } from "./utils.js"

/**
 * Encode a Web Streams API ReadableStream.
 * options.chunkRecycling has no effect here.
 */
export class CBOREncoderStream<T = CBORValue> extends TransformStream<CBORValue, Uint8Array> {
	constructor(...[options = {}]: T extends CBORValue
		? []|[EncodeOptions]
		: [WithRequired<EncodeOptions<Flatten<NoInfer<T>>>, "onValue">]
	) {
		const encoder = new Encoder({ ...options, chunkRecycling: false } as EncodeOptions)

		super({
			transform(value: CBORValue, controller: TransformStreamDefaultController<Uint8Array>) {
				// Encode the incoming value and push all resulting chunks
				for (const chunk of encoder.encodeValue(value)) {
					controller.enqueue(chunk)
				}
			},

			flush(controller: TransformStreamDefaultController<Uint8Array>) {
				// Push any remaining chunks when the stream is closing
				for (const chunk of encoder.flush()) {
					controller.enqueue(chunk)
				}
			},
		})
	}
}
