using System.Text.Json;
using System.Threading.Tasks;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.WebGPUPlayer.Modules;

/// <summary>
/// Offers the plugin's decoder packages and pass files to signed-in clients, and lets administrators upload, remove, enable, and disable them.
/// A client fetches the catalog when it negotiates a playback, and a file only when a playback or a preset needs it.
/// </summary>
/// <param name="store">The module store.</param>
[ApiController]
[Authorize]
[Route(RoutePrefix)]
public sealed class ModuleController(ModuleStore store) : ControllerBase
{
    /// <summary>
    /// The route below the server base URL.
    /// </summary>
    public const string RoutePrefix = "WebGPUPlayer";

    /// <summary>
    /// The cache policy of the catalog and the files: each response revalidates, since an administrator may replace a file at any time.
    /// </summary>
    public const string RevalidateCacheControl = "private, no-cache";

    private static readonly JsonSerializerOptions ResponseJsonOptions = new JsonSerializerOptions
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    /// <summary>
    /// Gets the decoder packages and pass files clients get.
    /// </summary>
    /// <returns>The catalog.</returns>
    [HttpGet("Catalog")]
    public IActionResult GetCatalog()
    {
        Response.Headers.CacheControl = RevalidateCacheControl;
        return new JsonResult(store.GetCatalog(), ResponseJsonOptions);
    }

    /// <summary>
    /// Gets every module file the store holds, for the settings page.
    /// </summary>
    /// <returns>The listing.</returns>
    [HttpGet("Catalog/All")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public IActionResult GetListing()
    {
        Response.Headers.CacheControl = RevalidateCacheControl;
        return new JsonResult(store.GetListing(), ResponseJsonOptions);
    }

    /// <summary>
    /// Gets an offered decoder package.
    /// </summary>
    /// <param name="id">The package id.</param>
    /// <returns>The package file, or 404 when no package of the id is offered.</returns>
    [HttpGet("DecoderPackages/{id}")]
    public IActionResult GetDecoderPackage([FromRoute] string id)
    {
        (byte[] Bytes, string ContentHash)? file = store.GetOfferedDecoderPackage(id);
        return file is null ? NotFound() : CreateFileResult(file.Value.Bytes, file.Value.ContentHash, DecoderPackageFunctions.ContentType);
    }

    /// <summary>
    /// Stores an uploaded decoder package, the request body, under the id its header declares.
    /// </summary>
    /// <returns>The listing, or 400 with the failed check.</returns>
    [HttpPost("DecoderPackages")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [RequestSizeLimit(DecoderPackageFunctions.MaximumByteLength)]
    public async Task<IActionResult> AddDecoderPackage()
    {
        byte[]? bytes = await RequestBodyFunctions.ReadBodyAsync(Request.Body, DecoderPackageFunctions.MaximumByteLength, HttpContext.RequestAborted).ConfigureAwait(false);
        return bytes is null ? CreateTooLargeResult() : CreateChangeResult(store.AddDecoderPackage(bytes));
    }

    /// <summary>
    /// Deletes an uploaded decoder package, which restores a bundled package of its id.
    /// </summary>
    /// <param name="id">The package id.</param>
    /// <returns>The listing, or 404 when no upload has the id.</returns>
    [HttpDelete("DecoderPackages/{id}")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public IActionResult RemoveDecoderPackage([FromRoute] string id)
    {
        return CreateChangeResult(store.RemoveDecoderPackage(id));
    }

    /// <summary>
    /// Offers a decoder package id to clients again.
    /// </summary>
    /// <param name="id">The package id.</param>
    /// <returns>The listing, or 404 for an unknown id.</returns>
    [HttpPut("DecoderPackages/{id}/Enabled")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public IActionResult EnableDecoderPackage([FromRoute] string id)
    {
        return CreateChangeResult(store.SetDecoderPackageEnabled(id, true));
    }

    /// <summary>
    /// Stops offering a decoder package id to clients.
    /// </summary>
    /// <param name="id">The package id.</param>
    /// <returns>The listing, or 404 for an unknown id.</returns>
    [HttpDelete("DecoderPackages/{id}/Enabled")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public IActionResult DisableDecoderPackage([FromRoute] string id)
    {
        return CreateChangeResult(store.SetDecoderPackageEnabled(id, false));
    }

    /// <summary>
    /// Gets an offered pass file.
    /// </summary>
    /// <param name="fileName">The pass file name.</param>
    /// <returns>The pass file, or 404 when no pass file of the name is offered.</returns>
    [HttpGet("Passes/{fileName}")]
    public IActionResult GetPass([FromRoute] string fileName)
    {
        (byte[] Bytes, string ContentHash)? file = store.GetOfferedPass(fileName);
        return file is null ? NotFound() : CreateFileResult(file.Value.Bytes, file.Value.ContentHash, PassFileFunctions.ContentType);
    }

    /// <summary>
    /// Stores an uploaded pass file, the request body, under its name.
    /// </summary>
    /// <param name="fileName">The pass file name.</param>
    /// <returns>The listing, or 400 with the failed check.</returns>
    [HttpPost("Passes")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [RequestSizeLimit(PassFileFunctions.MaximumByteLength)]
    public async Task<IActionResult> AddPass([FromQuery] string? fileName)
    {
        // The name is checked before the body is read
        ModuleProblem? fileNameProblem = PassFileFunctions.FindFileNameProblem(fileName);
        if (fileNameProblem is not null)
        {
            return CreateChangeResult(fileNameProblem);
        }

        byte[]? bytes = await RequestBodyFunctions.ReadBodyAsync(Request.Body, PassFileFunctions.MaximumByteLength, HttpContext.RequestAborted).ConfigureAwait(false);
        return bytes is null ? CreateTooLargeResult() : CreateChangeResult(store.AddPass(fileName!, bytes));
    }

    /// <summary>
    /// Deletes an uploaded pass file, which restores a bundled file of its name.
    /// </summary>
    /// <param name="fileName">The pass file name.</param>
    /// <returns>The listing, or 404 when no upload has the name.</returns>
    [HttpDelete("Passes/{fileName}")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public IActionResult RemovePass([FromRoute] string fileName)
    {
        return CreateChangeResult(store.RemovePass(fileName));
    }

    /// <summary>
    /// Offers a pass file name to clients again.
    /// </summary>
    /// <param name="fileName">The pass file name.</param>
    /// <returns>The listing, or 404 for an unknown name.</returns>
    [HttpPut("Passes/{fileName}/Enabled")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public IActionResult EnablePass([FromRoute] string fileName)
    {
        return CreateChangeResult(store.SetPassEnabled(fileName, true));
    }

    /// <summary>
    /// Stops offering a pass file name to clients.
    /// </summary>
    /// <param name="fileName">The pass file name.</param>
    /// <returns>The listing, or 404 for an unknown name.</returns>
    [HttpDelete("Passes/{fileName}/Enabled")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public IActionResult DisablePass([FromRoute] string fileName)
    {
        return CreateChangeResult(store.SetPassEnabled(fileName, false));
    }

    /// <summary>
    /// Serves a module file whose entity tag is its content hash, so a revalidation of an unchanged file is a 304.
    /// </summary>
    private FileContentResult CreateFileResult(byte[] bytes, string contentHash, string contentType)
    {
        Response.Headers.CacheControl = RevalidateCacheControl;
        return File(bytes, contentType, lastModified: null, entityTag: new EntityTagHeaderValue("\"" + contentHash + "\""));
    }

    /// <summary>
    /// Answers an administrator's change with the new listing, or with the failed check: 404 for an unknown key, 500 for a refused write, else 400.
    /// </summary>
    private IActionResult CreateChangeResult(ModuleProblem? problem)
    {
        if (problem is null)
        {
            return new JsonResult(store.GetListing(), ResponseJsonOptions);
        }

        JsonResult result = new JsonResult(problem, ResponseJsonOptions)
        {
            StatusCode = problem.Code switch
            {
                ModuleProblem.UnknownModuleCode => StatusCodes.Status404NotFound,
                ModuleProblem.WriteFailedCode => StatusCodes.Status500InternalServerError,
                _ => StatusCodes.Status400BadRequest
            }
        };
        return result;
    }

    private JsonResult CreateTooLargeResult()
    {
        return new JsonResult(new ModuleProblem(ModuleProblem.SizeCode, "the body is larger than its kind allows"), ResponseJsonOptions)
        {
            StatusCode = StatusCodes.Status413PayloadTooLarge
        };
    }
}
