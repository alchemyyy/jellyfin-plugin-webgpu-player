using System.Collections.Generic;
using System.Net.Mime;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Plugin.WebGPUPlayer.Modules;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using HeaderNames = Microsoft.Net.Http.Headers.HeaderNames;

namespace Jellyfin.Plugin.WebGPUPlayer.Diagnostics;

/// <summary>
/// Writes the reports of signed-in clients to the server log, so an administrator can read in Dashboard &gt; Logs what stopped a client's pages.
/// </summary>
/// <param name="logger">The logger the reports are written to.</param>
[ApiController]
[Authorize]
[Route(ModuleController.RoutePrefix)]
public sealed class DiagnosticsController(ILogger<DiagnosticsController> logger) : ControllerBase
{
    // Jellyfin's own authorization header, which clients send where they cannot set Authorization
    private const string EmbyAuthorizationHeader = "X-Emby-Authorization";

    private static readonly JsonSerializerOptions ResponseJsonOptions = new JsonSerializerOptions
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    /// <summary>
    /// Logs a warning for each capability probe the request body, <c>{ "crashes": [ { "probe": "...", "steps": [ "..." ] } ] }</c>, reports stopping a page of the client.
    /// </summary>
    /// <returns>204, or 400 with the failed check.</returns>
    [HttpPost("Diagnostics/ProbeCrashes")]
    [Consumes(MediaTypeNames.Application.Json)]
    [RequestSizeLimit(ProbeCrashFunctions.MaximumByteLength)]
    public async Task<IActionResult> ReportProbeCrashes()
    {
        byte[]? bytes = await RequestBodyFunctions.ReadBodyAsync(Request.Body, ProbeCrashFunctions.MaximumByteLength, HttpContext.RequestAborted).ConfigureAwait(false);
        if (bytes is null)
        {
            return CreateProblemResult(new ProbeCrashProblem(ProbeCrashProblem.SizeCode, ProbeCrashFunctions.SizeDetail));
        }

        (IReadOnlyList<ProbeCrash>? crashes, ProbeCrashProblem? problem) = ProbeCrashFunctions.ReadReport(bytes);
        if (crashes is null)
        {
            return CreateProblemResult(problem!);
        }

        // Only the client parts of the headers are read; the token and the device id never reach the log
        ProbeCrashReporter reporter = ProbeCrashFunctions.ReadReporter(
            Request.Headers[HeaderNames.UserAgent],
            Request.Headers[HeaderNames.Authorization],
            Request.Headers[EmbyAuthorizationHeader]);
        foreach (ProbeCrash crash in crashes)
        {
            logger.LogWarning(
                "WebGPU Player: the capability probe {Probe} stopped a page during {Steps} on {Client} {ClientVersion} ({Device}, {UserAgent})",
                crash.Probe,
                ProbeCrashFunctions.FormatSteps(crash.Steps),
                reporter.Client,
                reporter.ClientVersion,
                reporter.Device,
                reporter.UserAgent);
        }

        return NoContent();
    }

    // Every refused report answers 400, an oversized one too, so a client handles one failure
    private static JsonResult CreateProblemResult(ProbeCrashProblem problem)
    {
        return new JsonResult(problem, ResponseJsonOptions)
        {
            StatusCode = StatusCodes.Status400BadRequest
        };
    }
}
