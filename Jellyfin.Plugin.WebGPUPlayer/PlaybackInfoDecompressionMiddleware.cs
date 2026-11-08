using System;
using System.IO;
using System.IO.Compression;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Primitives;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.WebGPUPlayer;

/// <summary>
/// Decompresses the gzipped PlaybackInfo request bodies the add-on sends, so Jellyfin reads them as plain JSON.
/// The add-on's device profile makes these bodies large, and gzip cuts their upload time; other requests pass through untouched.
/// The middleware runs ahead of Jellyfin's authentication, so a body is decompressed only for a request whose credentials Jellyfin accepts:
/// Jellyfin refuses any other one before it reads the body, and a few kilobytes of gzip must not make the server inflate megabytes for it.
/// </summary>
/// <param name="next">The next middleware.</param>
public sealed class PlaybackInfoDecompressionMiddleware(RequestDelegate next)
{
    /// <summary>
    /// The largest decompressed PlaybackInfo body, in bytes.
    /// </summary>
    public const int MaximumDecompressedByteLength = 16 * 1024 * 1024;

    private const string GzipCoding = "gzip";

    /// <summary>
    /// Replaces a gzipped PlaybackInfo POST body with its decompressed JSON and runs the next layer.
    /// </summary>
    /// <param name="context">The request context.</param>
    /// <returns>A task that completes when the response is written.</returns>
    public async Task InvokeAsync(HttpContext context)
    {
        HttpRequest request = context.Request;
        if (!HttpMethods.IsPost(request.Method)
            || !IsPlaybackInfoPath(request.Path.Value)
            || !IsGzipOnly(request.Headers.ContentEncoding))
        {
            await next(context).ConfigureAwait(false);
            return;
        }

        if (!await IsAuthenticatedAsync(context).ConfigureAwait(false))
        {
            // Jellyfin answers it with 401 without reading the body, which stays compressed
            await next(context).ConfigureAwait(false);
            return;
        }

        byte[]? body;
        try
        {
            using GZipStream decompression = new GZipStream(request.Body, CompressionMode.Decompress, leaveOpen: true);
            body = await RequestBodyFunctions.ReadBodyAsync(decompression, MaximumDecompressedByteLength, context.RequestAborted).ConfigureAwait(false);
        }
        catch (InvalidDataException)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        if (body is null)
        {
            context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
            return;
        }

        MemoryStream decompressedBody = new MemoryStream(body, writable: false);
        context.Response.RegisterForDispose(decompressedBody);
        request.Body = decompressedBody;
        request.ContentLength = body.Length;
        request.Headers.Remove(HeaderNames.ContentEncoding);
        await next(context).ConfigureAwait(false);
    }

    /// <summary>
    /// Whether Jellyfin accepts the request's credentials, as its authentication reads them: a valid token of a user who is not disabled.
    /// A host without Jellyfin's authorization context, such as a test host, has no authentication ahead of the route either.
    /// </summary>
    private static async Task<bool> IsAuthenticatedAsync(HttpContext context)
    {
        IAuthorizationContext? authorizationContext = context.RequestServices?.GetService<IAuthorizationContext>();
        if (authorizationContext is null)
        {
            return true;
        }

        AuthorizationInfo authorization = await authorizationContext.GetAuthorizationInfo(context).ConfigureAwait(false);
        // A user locked out after failed sign-ins keeps a valid token, which Jellyfin's authentication still refuses
        return authorization.IsAuthenticated
            && !(authorization.User?.HasPermission(PermissionKind.IsDisabled) ?? false);
    }

    private static bool IsPlaybackInfoPath(string? path)
    {
        if (string.IsNullOrEmpty(path))
        {
            return false;
        }

        string[] segments = path.Split('/');
        int count = segments.Length;
        return count >= 4
            && segments[count - 1].Equals("PlaybackInfo", StringComparison.OrdinalIgnoreCase)
            && segments[count - 2].Length > 0
            && segments[count - 3].Equals("Items", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsGzipOnly(StringValues contentEncoding)
    {
        string? coding = null;
        foreach (string? value in contentEncoding)
        {
            foreach (string part in (value ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (coding is not null)
                {
                    return false;
                }

                coding = part;
            }
        }

        return string.Equals(coding, GzipCoding, StringComparison.OrdinalIgnoreCase);
    }
}
