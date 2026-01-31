export const maxSafeInteger = BigInt(Number.MAX_SAFE_INTEGER)
export const minSafeInteger = BigInt(Number.MIN_SAFE_INTEGER)

export class UnsafeIntegerError extends RangeError {
	public constructor(
		message: string,
		readonly value: bigint,
	) {
		super(message)
	}
}

export class AssertError extends Error {
	public constructor(
		public readonly message: string,
		public readonly props?: any,
	) {
		super(message)
	}
}

export function assert(condition: unknown, message = "assertion failed", props?: any): asserts condition {
	if (!condition) {
		throw new AssertError(message, props)
	}
}

// https://github.com/feross/buffer/blob/57caad4450d241207066ca3832fb8e9095ad402f/index.js#L434
export function getByteLength(string: string): number {
	let codePoint

	const length = string.length
	let leadSurrogate = null

	let bytes = 0

	for (let i = 0; i < length; ++i) {
		codePoint = string.charCodeAt(i)

		// is surrogate component
		if (codePoint > 0xd7ff && codePoint < 0xe000) {
			// last char was a lead
			if (!leadSurrogate) {
				// no lead yet
				if (codePoint > 0xdbff) {
					// unexpected trail
					bytes += 3
					continue
				} else if (i + 1 === length) {
					// unpaired lead
					bytes += 3
					continue
				}

				// valid lead
				leadSurrogate = codePoint

				continue
			}

			// 2 leads in a row
			if (codePoint < 0xdc00) {
				bytes += 3
				leadSurrogate = codePoint
				continue
			}

			// valid surrogate pair
			codePoint = (((leadSurrogate - 0xd800) << 10) | (codePoint - 0xdc00)) + 0x10000
		} else if (leadSurrogate) {
			// valid bmp char, but last char was a lead
			bytes += 3
		}

		leadSurrogate = null

		// encode utf8
		if (codePoint < 0x80) {
			bytes += 1
		} else if (codePoint < 0x800) {
			bytes += 2
		} else if (codePoint < 0x10000) {
			bytes += 3
		} else if (codePoint < 0x110000) {
			bytes += 4
		} else {
			throw new Error("Invalid code point")
		}
	}

	return bytes
}

export function createTransformWithBackpressure<I, O>(
	transform: (chunk: I, enqueue: (out: O) => Promise<void>) => Awaitable<void>,
	flush?: (enqueue: (out: O) => Promise<void>) => Awaitable<void>
): ReadableWritablePair<O, I> {
	let readableController: ReadableStreamDefaultController<O>
	let pullResolve: (() => void) | null = null
	let closed = false

	const enqueue = async (out: O) => {
		if (closed) throw new Error('Stream closed: cannot enqueue')
		readableController.enqueue(out)
		await new Promise<void>(res => {
			pullResolve = () => {
				pullResolve = null
				res()
			}
		})
	}

	const readable = new ReadableStream<O>({
		start(controller) {
			readableController = controller
		},
		pull() {
			pullResolve?.()
		},
		cancel() {
			closed = true
			pullResolve?.()
		}
	}, { highWaterMark: 1 })

	const writable = new WritableStream<I>({
		write(chunk) {
			return transform(chunk, enqueue)
		},
		async close() {
			pullResolve?.()
			if (flush) await flush(enqueue)
			closed = true
			readableController.close()
		},
		abort(e) {
			closed = true
			pullResolve?.()
			readableController.error(e)
		}
	}, { highWaterMark: 1 })

	return { readable, writable }
}

export type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };

export type DeepValueUnion<T> =
	T extends readonly (infer E)[]
		? DeepValueUnion<E>
		: T extends Record<string, unknown>
			? { [K in keyof T]: DeepValueUnion<T[K]> }[keyof T]
			: T

export type Flatten<T> =
	| DeepValueUnion<T>
	| Flatten<T>[]
	| { [K: string]: Flatten<T> }

export type NoInfer<T> = [T][T extends any ? 0 : never]

export type Awaitable<T> = T | PromiseLike<T>
