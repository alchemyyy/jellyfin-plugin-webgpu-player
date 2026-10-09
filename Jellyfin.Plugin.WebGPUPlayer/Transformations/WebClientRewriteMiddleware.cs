using System;
using System.IO;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Primitives;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.WebGPUPlayer.Transformations;

/// <summary>
/// Rewrites <c>index.html</c> and <c>config.json</c> when File Transformation does not.
/// It composes with other rewriting middleware: it always calls the next layer, asks it for the complete uncompressed file, and replaces the validators of the response it changes.
/// </summary>
/// <param name="next">The next middleware.</param>
/// <param name="getBaseUrl">Returns the server base URL.</param>
/// <param name="isActive">Returns whether this middleware rewrites; it stays inert while File Transformation handles the files.</param>
/// <param name="rewrite">Rewrites a file's text, or returns <c>null</c> to serve it unchanged.</param>
/// <param name="logger">The logger.</param>
public sealed class WebClientRewriteMiddleware(
    RequestDelegate next,
    Func<string> getBaseUrl,
    Func<bool> isActive,
    Func<WebClientFile, string, string?> rewrite,
    ILogger<WebClientRewriteMiddleware> logger)
{
    /// <summary>
    /// Runs the next layer and, while active, rewrites its response to a GET of <c>index.html</c> or <c>config.json</c>.
    /// </summary>
    /// <param name="context">The request context.</param>
    /// <returns>A task that completes when the response is written.</returns>
    public async Task InvokeAsync(HttpContext context)
    {
        WebClientFile? file = HttpMethods.IsGet(context.Request.Method)
            ? WebClientRewriteFunctions.GetTargetFile(getBaseUrl(), context.Request.Path.Value)
            : null;
        if (file is null || !isActive())
        {
            await next(context).ConfigureAwait(false);
            return;
        }

        // Inner 304s, ranges and encodings would describe the unmodified file, so inner layers must send all of it as plain text
        IHeaderDictionary requestHeaders = context.Request.Headers;
        StringValues ifNoneMatch = requestHeaders.IfNoneMatch;
        requestHeaders.Remove(HeaderNames.AcceptEncoding);
        requestHeaders.Remove(HeaderNames.IfNoneMatch);
        requestHeaders.Remove(HeaderNames.IfModifiedSince);
        requestHeaders.Remove(HeaderNames.IfMatch);
        requestHeaders.Remove(HeaderNames.IfUnmodifiedSince);
        requestHeaders.Remove(HeaderNames.IfRange);
        requestHeaders.Remove(HeaderNames.Range);

        HttpResponse response = context.Response;
        Stream originalBody = response.Body;
        using MemoryStream bufferedBody = new MemoryStream();
        response.Body = bufferedBody;
        try
        {
            await next(context).ConfigureAwait(false);
        }
        finally
        {
            response.Body = originalBody;
        }

        byte[] innerContent = bufferedBody.ToArray();
        string? rewrittenText = CanRewrite(response) ? RewriteContent(file.Value, innerContent) : null;
        if (rewrittenText is null)
        {
            await originalBody.WriteAsync(innerContent, context.RequestAborted).ConfigureAwait(false);
            return;
        }

        byte[] rewrittenContent = WebClientRewriteFunctions.EncodeUTF8(rewrittenText);
        string etag = WebClientRewriteFunctions.ComputeETag(rewrittenContent);
        IHeaderDictionary responseHeaders = response.Headers;
        responseHeaders.Remove(HeaderNames.LastModified);
        responseHeaders.Remove(HeaderNames.AcceptRanges);
        responseHeaders.ETag = etag;
        responseHeaders.CacheControl = WebClientRewriteFunctions.RevalidateCacheControl;
        if (WebClientRewriteFunctions.MatchesIfNoneMatch(ifNoneMatch, etag))
        {
            response.StatusCode = StatusCodes.Status304NotModified;
            response.ContentLength = null;
            return;
        }

        response.ContentLength = rewrittenContent.Length;
        await originalBody.WriteAsync(rewrittenContent, context.RequestAborted).ConfigureAwait(false);
    }

    private static bool CanRewrite(HttpResponse response)
    {
        // A text rewrite would corrupt an encoded body, so anything but a plain 200 passes through
        return response.StatusCode == StatusCodes.Status200OK && StringValues.IsNullOrEmpty(response.Headers.ContentEncoding);
    }

    private string? RewriteContent(WebClientFile file, byte[] content)
    {
        string? text = WebClientRewriteFunctions.DecodeUTF8(content);
        if (text is null)
        {
            logger.LogWarning("WebGPU Player left {File} unchanged because it is not valid UTF-8", file);
            return null;
        }

        return rewrite(file, text);
    }
}
