using System.Collections.Generic;
using System.Net.Mime;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Plugin.WebGPUPlayer.Modules;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.WebGPUPlayer.ClientDefaults;

/// <summary>
/// Offers the administrator's client defaults to signed-in clients, and lets administrators replace them.
/// </summary>
/// <param name="store">The client defaults store.</param>
[ApiController]
[Authorize]
[Route(ModuleController.RoutePrefix)]
public sealed class ClientDefaultsController(ClientDefaultsStore store) : ControllerBase
{
    private const string ClientDefaultsPath = "ClientDefaults";

    private static readonly JsonSerializerOptions ResponseJsonOptions = new JsonSerializerOptions
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    /// <summary>
    /// Gets the client defaults.
    /// </summary>
    /// <returns>The defaults.</returns>
    [HttpGet(ClientDefaultsPath)]
    public IActionResult GetClientDefaults()
    {
        // Each response revalidates, since an administrator may change the defaults at any time
        Response.Headers.CacheControl = ModuleController.RevalidateCacheControl;
        return new JsonResult(new ClientDefaultsDocument(store.GetSettings()), ResponseJsonOptions);
    }

    /// <summary>
    /// Replaces the client defaults with the request body, <c>{ "settings": { ... } }</c>.
    /// </summary>
    /// <returns>The stored defaults, or the failed check: 413 for a body over the limit, 500 for a refused write, else 400.</returns>
    [HttpPut(ClientDefaultsPath)]
    [Authorize(Policy = Policies.RequiresElevation)]
    [Consumes(MediaTypeNames.Application.Json)]
    [RequestSizeLimit(ClientDefaultsFunctions.MaximumByteLength)]
    public async Task<IActionResult> SetClientDefaults()
    {
        byte[]? bytes = await RequestBodyFunctions.ReadBodyAsync(Request.Body, ClientDefaultsFunctions.MaximumByteLength, HttpContext.RequestAborted).ConfigureAwait(false);
        if (bytes is null)
        {
            return CreateProblemResult(new ClientDefaultsProblem(ClientDefaultsProblem.SizeCode, ClientDefaultsFunctions.SizeDetail));
        }

        (IReadOnlyDictionary<string, JsonElement>? settings, ClientDefaultsProblem? problem) = store.SetDocument(bytes);
        return settings is null
            ? CreateProblemResult(problem!)
            : new JsonResult(new ClientDefaultsDocument(settings), ResponseJsonOptions);
    }

    private static JsonResult CreateProblemResult(ClientDefaultsProblem problem)
    {
        return new JsonResult(problem, ResponseJsonOptions)
        {
            StatusCode = problem.Code switch
            {
                ClientDefaultsProblem.SizeCode => StatusCodes.Status413PayloadTooLarge,
                ClientDefaultsProblem.WriteFailedCode => StatusCodes.Status500InternalServerError,
                _ => StatusCodes.Status400BadRequest
            }
        };
    }
}
