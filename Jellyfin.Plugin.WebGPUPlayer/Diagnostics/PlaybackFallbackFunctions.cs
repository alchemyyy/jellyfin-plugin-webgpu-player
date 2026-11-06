using System;
using System.Collections.Generic;
using System.Text.Json;

namespace Jellyfin.Plugin.WebGPUPlayer.Diagnostics;

/// <summary>
/// Reads a client's report of the playbacks that left the WebGPU route, <c>{ "fallbacks": [ { "kind": "...", "reason": "...", "detail": "..." } ] }</c>.
/// </summary>
public static class PlaybackFallbackFunctions
{
    /// <summary>
    /// The largest report, in bytes, which holds the largest valid report even with every character a quote or backslash that JSON escapes.
    /// </summary>
    public const int MaximumByteLength = 16 * 1024;

    /// <summary>
    /// The most fallbacks a report may hold.
    /// </summary>
    public const int MaximumFallbackCount = 16;

    /// <summary>
    /// The longest reason code.
    /// </summary>
    public const int MaximumReasonLength = 64;

    /// <summary>
    /// The longest detail.
    /// </summary>
    public const int MaximumDetailLength = 256;

    /// <summary>
    /// The kind of a WebGPU presentation that fell back to the browser's own video surface.
    /// </summary>
    public const string PresentationKind = "presentation";

    /// <summary>
    /// The kind of a GPU device the WebGPU presenter lost, whether it then recovered or fell back.
    /// </summary>
    public const string DeviceLostKind = "device-lost";

    /// <summary>
    /// The kind of a custom playback that stopped and handed its playback to the HTML player or a renegotiated source.
    /// </summary>
    public const string CustomPlaybackFallbackKind = "custom-playback-fallback";

    /// <summary>
    /// The kind of a custom playback that declined a source before it started.
    /// </summary>
    public const string CustomPlaybackDeclinedKind = "custom-playback-declined";

    /// <summary>
    /// What the log names the detail of a fallback whose client gave none.
    /// </summary>
    public const string NoDetail = "no detail";

    /// <summary>
    /// The code of a report whose shape or values the plugin refuses.
    /// </summary>
    public const string InvalidCode = "playback-fallbacks-invalid";

    /// <summary>
    /// The code of a report larger than <see cref="MaximumByteLength"/>.
    /// </summary>
    public const string SizeCode = "playback-fallbacks-size";

    /// <summary>
    /// The detail of a report over <see cref="MaximumByteLength"/>.
    /// </summary>
    internal const string SizeDetail = "the report is larger than 16 KiB";

    private const string FallbacksPropertyName = "fallbacks";
    private const string KindPropertyName = "kind";
    private const string ReasonPropertyName = "reason";
    private const string DetailPropertyName = "detail";

    // The report, its list, and a fallback are the only levels
    private static readonly JsonDocumentOptions DocumentOptions = new JsonDocumentOptions
    {
        MaxDepth = 3,
        AllowDuplicateProperties = false
    };

    /// <summary>
    /// Reads a report: 1 to 16 fallbacks, each a known kind, a reason of 1 to 64 printable ASCII characters, and a detail of 0 to 256, with no other property.
    /// </summary>
    /// <param name="bytes">The report.</param>
    /// <returns>The fallbacks, or the failed check.</returns>
    public static (IReadOnlyList<PlaybackFallback>? Fallbacks, ReportProblem? Problem) ReadReport(byte[] bytes)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        if (bytes.Length > MaximumByteLength)
        {
            return (null, new ReportProblem(SizeCode, SizeDetail));
        }

        JsonDocument document;
        try
        {
            // Strict JSON: no comments, trailing commas, or duplicate properties, and nesting no deeper than a report's
            document = JsonDocument.Parse(bytes, DocumentOptions);
        }
        catch (JsonException exception)
        {
            return Refuse<IReadOnlyList<PlaybackFallback>>(exception.Message);
        }

        using (document)
        {
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !ReportFunctions.HasOnlyProperties(root, FallbacksPropertyName))
            {
                return Refuse<IReadOnlyList<PlaybackFallback>>("the report is not an object of 'fallbacks' only");
            }

            if (!root.TryGetProperty(FallbacksPropertyName, out JsonElement fallbacksElement) || fallbacksElement.ValueKind != JsonValueKind.Array)
            {
                return Refuse<IReadOnlyList<PlaybackFallback>>("'fallbacks' is not an array");
            }

            int fallbackCount = fallbacksElement.GetArrayLength();
            if (fallbackCount == 0)
            {
                return Refuse<IReadOnlyList<PlaybackFallback>>("'fallbacks' is empty");
            }

            if (fallbackCount > MaximumFallbackCount)
            {
                return Refuse<IReadOnlyList<PlaybackFallback>>("more than 16 fallbacks");
            }

            List<PlaybackFallback> fallbacks = new List<PlaybackFallback>(fallbackCount);
            foreach (JsonElement fallbackElement in fallbacksElement.EnumerateArray())
            {
                (PlaybackFallback? fallback, ReportProblem? problem) = ReadFallback(fallbackElement);
                if (fallback is null)
                {
                    return (null, problem);
                }

                fallbacks.Add(fallback);
            }

            return (fallbacks, null);
        }
    }

    /// <summary>
    /// Names a fallback's detail for the server log.
    /// </summary>
    /// <param name="detail">The detail.</param>
    /// <returns>The detail, or <see cref="NoDetail"/> when it is empty.</returns>
    public static string FormatDetail(string detail)
    {
        ArgumentNullException.ThrowIfNull(detail);
        return detail.Length == 0 ? NoDetail : detail;
    }

    private static (PlaybackFallback? Fallback, ReportProblem? Problem) ReadFallback(JsonElement fallbackElement)
    {
        if (fallbackElement.ValueKind != JsonValueKind.Object
            || !ReportFunctions.HasOnlyProperties(fallbackElement, KindPropertyName, ReasonPropertyName, DetailPropertyName))
        {
            return Refuse<PlaybackFallback>("a fallback is not an object of 'kind', 'reason', and 'detail' only");
        }

        string? kind = fallbackElement.TryGetProperty(KindPropertyName, out JsonElement kindElement) ? ReportFunctions.ReadString(kindElement) : null;
        if (kind is not (PresentationKind or DeviceLostKind or CustomPlaybackFallbackKind or CustomPlaybackDeclinedKind))
        {
            return Refuse<PlaybackFallback>("a kind is not one of 'presentation', 'device-lost', 'custom-playback-fallback', and 'custom-playback-declined'");
        }

        string? reason = fallbackElement.TryGetProperty(ReasonPropertyName, out JsonElement reasonElement) ? ReportFunctions.ReadString(reasonElement) : null;
        if (reason is null || !ReportFunctions.IsPrintableAscii(reason, MaximumReasonLength))
        {
            return Refuse<PlaybackFallback>("a reason is not 1 to 64 printable ASCII characters");
        }

        string? detail = fallbackElement.TryGetProperty(DetailPropertyName, out JsonElement detailElement) ? ReportFunctions.ReadString(detailElement) : null;
        if (detail is null || (detail.Length > 0 && !ReportFunctions.IsPrintableAscii(detail, MaximumDetailLength)))
        {
            return Refuse<PlaybackFallback>("the detail of '" + reason + "' is not 0 to 256 printable ASCII characters");
        }

        return (new PlaybackFallback(kind, reason, detail), null);
    }

    private static (T? Value, ReportProblem? Problem) Refuse<T>(string detail)
        where T : class
    {
        return (null, new ReportProblem(InvalidCode, detail));
    }
}
