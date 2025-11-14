import { Decoder, type AsyncDecodeOptions } from "./decodeAsyncIterable.js"
import type { WithRequired, Flatten, NoInfer } from "./utils.js"
import type { CBORValue } from "./types.js"

/** Decode a Web Streams API ReadableStream */
export class CBORDecoderStream<T = CBORValue> extends TransformStream<Uint8Array, T> {
	constructor(...[options = {}]: T extends CBORValue
		? []|[AsyncDecodeOptions]
		: [WithRequired<AsyncDecodeOptions<Flatten<NoInfer<T>>>, "onValue">]
	) {
		let readableController: ReadableStreamDefaultController<Uint8Array>
		let pipePromise: Promise<void>

		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				readableController = controller
			},
		})

		// We need to track whick chunks have been "processed" and only resolve each
		// .transform() promise once all data from each chunk has been enqueued.
		const chunks = new WeakMap<Uint8Array, { resolve: () => void }>()

		async function pipe(controller: TransformStreamDefaultController<T>) {
			const decoder = new Decoder(readable.values(), {
				...options,
				onFree: (chunk) => chunks.get(chunk)?.resolve(),
			} as AsyncDecodeOptions)

			for await (const value of decoder) {
				controller.enqueue(value as T)
			}
		}

		super({
			start(controller) {
				pipePromise = pipe(controller).catch((err) => controller.error(err))
			},

			transform(chunk) {
				return new Promise<void>((resolve) => {
					chunks.set(chunk, { resolve })
					readableController.enqueue(chunk)
				})
			},

			async flush() {
				readableController.close()
				// Wait for pipe to complete before finishing flush
				await pipePromise
			},
		})
	}
}
