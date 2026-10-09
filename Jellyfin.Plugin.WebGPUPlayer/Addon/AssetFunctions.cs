using System;
using System.Collections.Frozen;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.WebGPUPlayer.Addon;

/// <summary>
/// Stateless rules for serving the embedded client add-on.
/// </summary>
public static class AssetFunctions
{
    /// <summary>
    /// The asset route below the server base URL.
    /// It must never contain <c>/web/</c>, because File Transformation intercepts every such path and handles text only.
    /// </summary>
    public const string RoutePrefix = "WebGPUPlayer/assets";

    /// <summary>
    /// The attribute route template of <see cref="AddonAssetController"/>.
    /// </summary>
    public const string RouteTemplate = RoutePrefix + "/{**path}";

    /// <summary>
    /// The logical-name prefix of embedded add-on files, set in the project file.
    /// </summary>
    public const string ResourcePrefix = "WebGPUPlayer.Assets/";

    /// <summary>
    /// The add-on manifest written by the client build (<c>npm run build</c> in <c>jellyfin-webgpu-client/</c>).
    /// </summary>
    public const string ManifestFileName = "addon-manifest.json";

    /// <summary>
    /// The cache policy of content-hashed or version-keyed files.
    /// </summary>
    public const string ImmutableCacheControl = "public, max-age=31536000, immutable";

    /// <summary>
    /// The cache policy of the manifest, whose name never changes.
    /// </summary>
    public const string RevalidateCacheControl = "no-cache";

    /// <summary>
    /// The content type of unknown extensions; the engine also fetches binary qualification vectors such as <c>.bin</c>.
    /// </summary>
    public const string FallbackContentType = "application/octet-stream";

    /// <summary>
    /// The content coding of Brotli precompressed siblings.
    /// </summary>
    public const string BrotliEncoding = "br";

    /// <summary>
    /// The content coding of gzip precompressed siblings.
    /// </summary>
    public const string GzipEncoding = "gzip";

    /// <summary>
    /// The file suffix of Brotli precompressed siblings.
    /// </summary>
    public const string BrotliExtension = ".br";

    /// <summary>
    /// The file suffix of gzip precompressed siblings.
    /// </summary>
    public const string GzipExtension = ".gz";

    private const string WildcardEncoding = "*";
    private const string SourceMapExtension = ".map";
    private const string SourceMapContentType = "application/json";
    private const string ManifestEntryProperty = "entry";
    private const char PathSeparator = '/';
    private const char WindowsPathSeparator = '\\';

    private static readonly FileExtensionContentTypeProvider ContentTypeProvider = CreateContentTypeProvider();
    private static readonly JsonDocumentOptions StrictDocumentOptions = new JsonDocumentOptions { AllowDuplicateProperties = false };

    /// <summary>
    /// Normalizes a request-relative asset path and rejects anything that is not a plain relative path.
    /// </summary>
    /// <param name="path">The path below the asset route, with either separator.</param>
    /// <param name="normalizedPath">The path with forward slashes, or an empty string when rejected.</param>
    /// <returns><c>true</c> when the path is relative and has no empty, <c>.</c> or <c>..</c> segment.</returns>
    public static bool TryNormalizePath(string? path, out string normalizedPath)
    {
        normalizedPath = string.Empty;
        if (string.IsNullOrEmpty(path))
        {
            return false;
        }

        string candidate = path.Replace(WindowsPathSeparator, PathSeparator);
        foreach (string segment in candidate.Split(PathSeparator))
        {
            // Rooted, doubled or trailing separators leave an empty segment
            if (segment is "" or "." or "..")
            {
                return false;
            }
        }

        normalizedPath = candidate;
        return true;
    }

    /// <summary>
    /// Builds the lookup from request-relative asset path to manifest resource name.
    /// </summary>
    /// <param name="resourceNames">All manifest resource names of the plugin assembly.</param>
    /// <returns>An ordinal lookup that holds only add-on resources.</returns>
    public static FrozenDictionary<string, string> BuildResourceLookup(IEnumerable<string> resourceNames)
    {
        Dictionary<string, string> lookup = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string resourceName in resourceNames)
        {
            if (!resourceName.StartsWith(ResourcePrefix, StringComparison.Ordinal))
            {
                continue;
            }

            if (!TryNormalizePath(resourceName[ResourcePrefix.Length..], out string relativePath))
            {
                continue;
            }

            lookup.TryAdd(relativePath, resourceName);
        }

        return lookup.ToFrozenDictionary(StringComparer.Ordinal);
    }

    /// <summary>
    /// Gets the content type of an asset from its extension.
    /// </summary>
    /// <param name="path">The normalized asset path.</param>
    /// <returns>The mapped content type, or <see cref="FallbackContentType"/>.</returns>
    public static string GetContentType(string path)
    {
        return ContentTypeProvider.TryGetContentType(path, out string? contentType) ? contentType : FallbackContentType;
    }

    /// <summary>
    /// Gets the cache policy of an asset.
    /// </summary>
    /// <param name="path">The normalized asset path.</param>
    /// <returns><see cref="RevalidateCacheControl"/> for the root manifest, otherwise <see cref="ImmutableCacheControl"/>.</returns>
    public static string GetCacheControl(string path)
    {
        return string.Equals(path, ManifestFileName, StringComparison.Ordinal) ? RevalidateCacheControl : ImmutableCacheControl;
    }

    /// <summary>
    /// Picks the embedded representation of an asset: a precompressed sibling the client accepts, or the file itself.
    /// </summary>
    /// <param name="relativePath">The normalized path of the requested asset.</param>
    /// <param name="resourceLookup">The embedded asset lookup.</param>
    /// <param name="acceptEncoding">The parsed <c>Accept-Encoding</c> request header.</param>
    /// <returns>The asset path to serve, its content coding or <c>null</c> for identity, and whether the response varies by <c>Accept-Encoding</c>.</returns>
    public static (string AssetPath, string? ContentEncoding, bool VariesByEncoding) SelectRepresentation(
        string relativePath,
        IReadOnlyDictionary<string, string> resourceLookup,
        IEnumerable<StringWithQualityHeaderValue> acceptEncoding)
    {
        string brotliPath = relativePath + BrotliExtension;
        string gzipPath = relativePath + GzipExtension;
        bool hasBrotli = resourceLookup.ContainsKey(brotliPath);
        bool hasGzip = resourceLookup.ContainsKey(gzipPath);
        if (!hasBrotli && !hasGzip)
        {
            return (relativePath, null, false);
        }

        double? brotliQuality = null;
        double? gzipQuality = null;
        double? wildcardQuality = null;
        foreach (StringWithQualityHeaderValue coding in acceptEncoding)
        {
            // An absent quality means q=1, and q=0 means not acceptable
            double quality = coding.Quality ?? 1;
            switch (coding.Value.Value?.ToLowerInvariant())
            {
                case BrotliEncoding:
                    brotliQuality = quality;
                    break;
                case GzipEncoding:
                    gzipQuality = quality;
                    break;
                case WildcardEncoding:
                    wildcardQuality = quality;
                    break;
            }
        }

        double brotliPreference = hasBrotli ? (brotliQuality ?? wildcardQuality ?? 0) : 0;
        double gzipPreference = hasGzip ? (gzipQuality ?? wildcardQuality ?? 0) : 0;
        if (brotliPreference <= 0 && gzipPreference <= 0)
        {
            return (relativePath, null, true);
        }

        // Higher quality wins, and Brotli wins ties
        return brotliPreference >= gzipPreference
            ? (brotliPath, BrotliEncoding, true)
            : (gzipPath, GzipEncoding, true);
    }

    /// <summary>
    /// Reads the entry module from the add-on manifest and checks that it is embedded.
    /// </summary>
    /// <param name="manifestText">The manifest JSON, or <c>null</c> when it is not embedded.</param>
    /// <param name="resourceLookup">The embedded asset lookup.</param>
    /// <returns>The normalized entry path, or <c>null</c> with the reason the add-on is unusable.</returns>
    public static (string? Entry, string? Problem) ParseAddonManifest(string? manifestText, IReadOnlyDictionary<string, string> resourceLookup)
    {
        if (manifestText is null)
        {
            return (null, ManifestFileName + " is not embedded");
        }

        JsonNode? manifest;
        try
        {
            manifest = JsonNode.Parse(manifestText, documentOptions: StrictDocumentOptions);
        }
        catch (JsonException exception)
        {
            return (null, ManifestFileName + " is not valid JSON: " + exception.Message);
        }

        if (manifest is not JsonObject manifestObject
            || !manifestObject.TryGetPropertyValue(ManifestEntryProperty, out JsonNode? entryNode)
            || entryNode is not JsonValue entryValue
            || !entryValue.TryGetValue(out string? entry))
        {
            return (null, ManifestFileName + " has no string entry");
        }

        if (!TryNormalizePath(entry, out string entryPath))
        {
            return (null, ManifestFileName + " entry is not a relative asset path: " + entry);
        }

        return resourceLookup.ContainsKey(entryPath)
            ? (entryPath, null)
            : (null, ManifestFileName + " entry is not embedded: " + entryPath);
    }

    private static FileExtensionContentTypeProvider CreateContentTypeProvider()
    {
        FileExtensionContentTypeProvider provider = new FileExtensionContentTypeProvider();

        // Source maps are JSON (ECMA-426), but the framework maps .map to text/plain
        provider.Mappings[SourceMapExtension] = SourceMapContentType;
        return provider;
    }
}
