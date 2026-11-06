// Gzips request bodies with the browser's CompressionStream.

/** Returns the gzip encoding of the text's UTF-8 bytes, or null when CompressionStream is unavailable or fails. */
export async function gzipText(text: string): Promise<ArrayBuffer | null> {
    if (typeof CompressionStream !== 'function') {
        return null;
    }
    try {
        // eslint-disable-next-line compat/compat -- Browsers without CompressionStream return above and send the JSON plain
        const stream = new CompressionStream('gzip');
        const writer = stream.writable.getWriter();
        const reader = stream.readable.getReader();
        const chunks: Uint8Array[] = [];
        const readAll = async (): Promise<void> => {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    return;
                }
                chunks.push(value);
            }
        };
        await Promise.all([
            writer.write(new TextEncoder().encode(text)),
            writer.close(),
            readAll()
        ]);

        const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return bytes.buffer;
    } catch (error) {
        console.warn('[WebGPUPlayer] unable to gzip the request body; sending it uncompressed', error);
        return null;
    }
}
