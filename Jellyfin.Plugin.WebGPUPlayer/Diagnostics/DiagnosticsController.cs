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
/// Writes the reports of signed-in clients to the server log, so an administrator can read in Dashboard &gt; Logs what stopped a client's pages and why its playbacks left the WebGPU route.
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
            return CreateProblemResult(new ReportProblem(ProbeCrashFunctions.SizeCode, ProbeCrashFunctions.SizeDetail));
        }

        (IReadOnlyList<ProbeCrash>? crashes, ReportProblem? problem) = ProbeCrashFunctions.ReadReport(bytes);
        if (crashes is null)
        {
            return CreateProblemResult(problem!);
        }

        ClientReporter reporter = ReadReporter();
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

    /// <summary>
    /// Logs each fallback of the request body, <c>{ "fallbacks": [ { "kind": "...", "reason": "...", "detail": "..." } ] }</c>:
    /// a warning for a presentation fallback, a lost GPU device, or a custom playback fallback, and information for a custom playback that declined a source.
    /// </summary>
    /// <returns>204, or 400 with the failed check.</returns>
    [HttpPost("Diagnostics/PlaybackFallbacks")]
    [Consumes(MediaTypeNames.Application.Json)]
    [RequestSizeLimit(PlaybackFallbackFunctions.MaximumByteLength)]
    public async Task<IActionResult> ReportPlaybackFallbacks()
    {
        byte[]? bytes = await RequestBodyFunctions.ReadBodyAsync(Request.Body, PlaybackFallbackFunctions.MaximumByteLength, HttpContext.RequestAborted).ConfigureAwait(false);
        if (bytes is null)
        {
            return CreateProblemResult(new ReportProblem(PlaybackFallbackFunctions.SizeCode, PlaybackFallbackFunctions.SizeDetail));
        }

        (IReadOnlyList<PlaybackFallback>? fallbacks, ReportProblem? problem) = PlaybackFallbackFunctions.ReadReport(bytes);
        if (fallbacks is null)
        {
            return CreateProblemResult(problem!);
        }

        ClientReporter reporter = ReadReporter();
        foreach (PlaybackFallback fallback in fallbacks)
        {
            LogPlaybackFallback(fallback, reporter);
        }

        return NoContent();
    }

    // Every refused report answers 400, an oversized one too, so a client handles one failure
    private static JsonResult CreateProblemResult(ReportProblem problem)
    {
        return new JsonResult(problem, ResponseJsonOptions)
        {
            StatusCode = StatusCodes.Status400BadRequest
        };
    }

    // Only the client parts of the headers are read; the token and the device id never reach the log
    private ClientReporter ReadReporter()
    {
        return ReportFunctions.ReadReporter(
            Request.Headers[HeaderNames.UserAgent],
            Request.Headers[HeaderNames.Authorization],
            Request.Headers[EmbyAuthorizationHeader]);
    }

    private void LogPlaybackFallback(PlaybackFallback fallback, ClientReporter reporter)
    {
        string detail = PlaybackFallbackFunctions.FormatDetail(fallback.Detail);
        switch (fallback.Kind)
        {
            case PlaybackFallbackFunctions.PresentationKind:
                logger.LogWarning(
                    "WebGPU Player: WebGPU presentation fell back to the browser's video ({Reason}: {Detail}) on {Client} {ClientVersion} ({Device}, {UserAgent})",
                    fallback.Reason,
                    detail,
                    reporter.Client,
                    reporter.ClientVersion,
                    reporter.Device,
                    reporter.UserAgent);
                break;
            case PlaybackFallbackFunctions.DeviceLostKind:
                logger.LogWarning(
                    "WebGPU Player: the WebGPU device was lost ({Reason}: {Detail}) on {Client} {ClientVersion} ({Device}, {UserAgent})",
                    fallback.Reason,
                    detail,
                    reporter.Client,
                    reporter.ClientVersion,
                    reporter.Device,
                    reporter.UserAgent);
                break;
            case PlaybackFallbackFunctions.CustomPlaybackFallbackKind:
                logger.LogWarning(
                    "WebGPU Player: custom playback fell back ({Reason}: {Detail}) on {Client} {ClientVersion} ({Device}, {UserAgent})",
                    fallback.Reason,
                    detail,
                    reporter.Client,
                    reporter.ClientVersion,
                    reporter.Device,
                    reporter.UserAgent);
                break;
            default:
                // A declined source, the one other kind a report holds, is the route working as designed, as when the server transcodes
                logger.LogInformation(
                    "WebGPU Player: custom playback declined a source ({Reason}: {Detail}) on {Client} {ClientVersion} ({Device}, {UserAgent})",
                    fallback.Reason,
                    detail,
                    reporter.Client,
                    reporter.ClientVersion,
                    reporter.Device,
                    reporter.UserAgent);
                break;
        }
    }
}
