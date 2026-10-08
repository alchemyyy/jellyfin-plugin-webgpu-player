using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Primitives;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.WebGPUPlayer.Transformations;

/// <summary>
/// Stateless rules of the middleware that rewrites Jellyfin Web when File Transformation does not.
/// </summary>
public static class WebClientRewriteFunctions
{
    /// <summary>
    /// The cache policy of rewritten files. Browsers revalidate on every load, so installing, configuring or removing the plugin shows at once.
    /// </summary>
    public const string RevalidateCacheControl = "no-cache";

    private const string WebDirectoryPath = "/web/";
    private const int ETagHashLength = 8;
    private const string ETagQuote = "\"";

    private static readonly UTF8Encoding StrictUTF8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);
    private static readonly byte[] UTF8ByteOrderMark = [0xEF, 0xBB, 0xBF];

    /// <summary>
    /// Identifies a request for one of the rewritten Jellyfin Web files.
    /// </summary>
    /// <param name="baseUrl">The server base URL: empty, or a path that starts with a slash and has no trailing slash.</param>
    /// <param name="requestPath">The request path, which includes the base URL.</param>
    /// <returns>The requested file, or <c>null</c> for any other path.</returns>
    public static WebClientFile? GetTargetFile(string baseUrl, string? requestPath)
    {
        if (string.IsNullOrEmpty(requestPath) || !requestPath.StartsWith(baseUrl, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        ReadOnlySpan<char> webPath = requestPath.AsSpan(baseUrl.Length);
        if (!webPath.StartsWith(WebDirectoryPath, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        // Jellyfin serves the page for the bare web directory through its default files
        ReadOnlySpan<char> fileName = webPath[WebDirectoryPath.Length..];
        if (fileName.IsEmpty || fileName.Equals(FileTransformationRegistrar.IndexHTMLFileName, StringComparison.OrdinalIgnoreCase))
        {
            return WebClientFile.IndexHTML;
        }

        return fileName.Equals(FileTransformationRegistrar.ConfigJSONFileName, StringComparison.OrdinalIgnoreCase)
            ? WebClientFile.ConfigJSON
            : null;
    }

    /// <summary>
    /// Decides whether the middleware rewrites, so that it and File Transformation never both run.
    /// </summary>
    /// <param name="mode">The registrar's decision, or <see cref="WebClientRewriteMode.Undecided"/> while the server starts.</param>
    /// <param name="addonEmbedded">Whether a client add-on is embedded.</param>
    /// <param name="fileTransformationLoaded">Whether the File Transformation assembly is loaded.</param>
    /// <returns><c>true</c> when the middleware rewrites.</returns>
    public static bool IsMiddlewareActive(WebClientRewriteMode mode, bool addonEmbedded, bool fileTransformationLoaded)
    {
        // Requests can arrive before the registrar decides; File Transformation's presence predicts its decision
        return mode switch
        {
            WebClientRewriteMode.Middleware => true,
            WebClientRewriteMode.Undecided => addonEmbedded && !fileTransformationLoaded,
            _ => false,
        };
    }

    /// <summary>
    /// Rewrites a Jellyfin Web file with the callbacks File Transformation runs, so both paths serve identical text.
    /// </summary>
    /// <param name="file">The requested file.</param>
    /// <param name="contents">The served text.</param>
    /// <returns>The rewritten text, or <paramref name="contents"/> when there is nothing to inject.</returns>
    public static string? Rewrite(WebClientFile file, string contents)
    {
        TransformationPayload payload = new TransformationPayload { Contents = contents };
        return file switch
        {
            WebClientFile.IndexHTML => TransformationCallbacks.TransformIndexHTML(payload),
            WebClientFile.ConfigJSON => TransformationCallbacks.TransformConfigJSON(payload),
            _ => contents,
        };
    }

    /// <summary>
    /// Decodes a served file as UTF-8, skipping a byte order mark.
    /// </summary>
    /// <param name="content">The served bytes.</param>
    /// <returns>The text, or <c>null</c> when the bytes are not valid UTF-8.</returns>
    public static string? DecodeUTF8(byte[] content)
    {
        int start = content.AsSpan().StartsWith(UTF8ByteOrderMark) ? UTF8ByteOrderMark.Length : 0;
        try
        {
            return StrictUTF8.GetString(content, start, content.Length - start);
        }
        catch (DecoderFallbackException)
        {
            // Recovery: the caller serves the original bytes untouched
            return null;
        }
    }

    /// <summary>
    /// Encodes rewritten text as UTF-8 without a byte order mark.
    /// </summary>
    /// <param name="text">The rewritten text.</param>
    /// <returns>The bytes to serve.</returns>
    public static byte[] EncodeUTF8(string text)
    {
        return StrictUTF8.GetBytes(text);
    }

    /// <summary>
    /// Computes a strong entity tag from the served bytes.
    /// </summary>
    /// <param name="content">The bytes to serve.</param>
    /// <returns>A quoted tag of the first eight bytes of the SHA-256 hash.</returns>
    public static string ComputeETag(ReadOnlySpan<byte> content)
    {
        Span<byte> hash = stackalloc byte[SHA256.HashSizeInBytes];
        SHA256.HashData(content, hash);
        return ETagQuote + Convert.ToHexStringLower(hash[..ETagHashLength]) + ETagQuote;
    }

    /// <summary>
    /// Evaluates <c>If-None-Match</c> against the rewritten representation, with the weak comparison it requires.
    /// </summary>
    /// <param name="ifNoneMatch">The request's <c>If-None-Match</c> values.</param>
    /// <param name="etag">The quoted tag of the rewritten file.</param>
    /// <returns><c>true</c> when the client already holds this representation.</returns>
    public static bool MatchesIfNoneMatch(StringValues ifNoneMatch, string etag)
    {
        if (StringValues.IsNullOrEmpty(ifNoneMatch) || !EntityTagHeaderValue.TryParseList(ifNoneMatch, out IList<EntityTagHeaderValue>? clientTags))
        {
            return false;
        }

        EntityTagHeaderValue currentTag = new EntityTagHeaderValue(etag);
        foreach (EntityTagHeaderValue clientTag in clientTags)
        {
            if (clientTag.Equals(EntityTagHeaderValue.Any) || clientTag.Compare(currentTag, useStrongComparison: false))
            {
                return true;
            }
        }

        return false;
    }
}
