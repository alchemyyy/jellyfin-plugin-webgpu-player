using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.WebGPUPlayer;

/// <summary>
/// Reads the request bodies of the plugin's routes.
/// </summary>
internal static class RequestBodyFunctions
{
    private const int BufferByteLength = 81920;

    /// <summary>
    /// Reads a request body, or returns <c>null</c> once it passes the limit, which hosts without a request size limit also need.
    /// </summary>
    /// <param name="body">The request body.</param>
    /// <param name="maximumByteLength">The largest body, in bytes.</param>
    /// <param name="cancellationToken">The request's cancellation.</param>
    /// <returns>The body, or <c>null</c> when it is larger than the limit.</returns>
    public static async Task<byte[]?> ReadBodyAsync(Stream body, int maximumByteLength, CancellationToken cancellationToken)
    {
        using MemoryStream copy = new MemoryStream();
        byte[] buffer = new byte[BufferByteLength];
        while (true)
        {
            int readByteLength;
            try
            {
                readByteLength = await body.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            }
            catch (BadHttpRequestException exception) when (exception.StatusCode == StatusCodes.Status413PayloadTooLarge)
            {
                // Kestrel enforces a route's request size limit by throwing on the read past it, which the server would answer with a 500
                return null;
            }

            if (readByteLength == 0)
            {
                return copy.ToArray();
            }

            if (copy.Length + readByteLength > maximumByteLength)
            {
                return null;
            }

            await copy.WriteAsync(buffer.AsMemory(0, readByteLength), cancellationToken).ConfigureAwait(false);
        }
    }
}
