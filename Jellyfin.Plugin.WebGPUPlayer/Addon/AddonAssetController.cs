using System.IO;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.WebGPUPlayer.Addon;

/// <summary>
/// Serves the embedded client add-on.
/// It is anonymous because module imports, workers and WASM fetches carry no Jellyfin token.
/// </summary>
[ApiExplorerSettings(IgnoreApi = true)]
[Route(AssetFunctions.RouteTemplate)]
public sealed class AddonAssetController : ControllerBase
{
    /// <summary>
    /// Gets an embedded add-on file, or its precompressed sibling when the client accepts one.
    /// </summary>
    /// <param name="path">The file path below the asset route.</param>
    /// <returns>The file, or 404 for unknown and non-relative paths.</returns>
    [HttpGet]
    [AllowAnonymous]
    public IActionResult GetAsset([FromRoute] string? path)
    {
        if (!AssetFunctions.TryNormalizePath(path, out string relativePath) || !AddonCatalog.Resources.ContainsKey(relativePath))
        {
            return NotFound();
        }

        (string assetPath, string? contentEncoding, bool variesByEncoding) = AssetFunctions.SelectRepresentation(
            relativePath,
            AddonCatalog.Resources,
            Request.GetTypedHeaders().AcceptEncoding);
        Stream? stream = AddonCatalog.OpenAsset(assetPath);
        if (stream is null)
        {
            return NotFound();
        }

        if (variesByEncoding)
        {
            Response.Headers.Vary = HeaderNames.AcceptEncoding;
        }

        if (contentEncoding is not null)
        {
            Response.Headers.ContentEncoding = contentEncoding;
        }

        Response.Headers.CacheControl = AssetFunctions.GetCacheControl(relativePath);
        return File(stream, AssetFunctions.GetContentType(relativePath));
    }
}
