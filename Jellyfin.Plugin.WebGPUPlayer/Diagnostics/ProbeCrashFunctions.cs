using System;
using System.Collections.Generic;
using System.Text.Json;

namespace Jellyfin.Plugin.WebGPUPlayer.Diagnostics;

/// <summary>
/// Reads a client's report of the capability probes that stopped its pages, <c>{ "crashes": [ { "probe": "...", "steps": [ "..." ] } ] }</c>.
/// </summary>
public static class ProbeCrashFunctions
{
    /// <summary>
    /// The largest report, in bytes, which holds the largest valid report even with every character a quote or backslash that JSON escapes.
    /// </summary>
    public const int MaximumByteLength = 64 * 1024;

    /// <summary>
    /// The most crashes a report may hold.
    /// </summary>
    public const int MaximumCrashCount = 16;

    /// <summary>
    /// The longest probe name.
    /// </summary>
    public const int MaximumProbeLength = 64;

    /// <summary>
    /// The most steps a crash may hold.
    /// </summary>
    public const int MaximumStepCount = 16;

    /// <summary>
    /// The longest step label.
    /// </summary>
    public const int MaximumStepLength = 96;

    /// <summary>
    /// What the log names the steps of a crash whose page recorded none.
    /// </summary>
    public const string NoSteps = "no recorded call";

    /// <summary>
    /// The code of a report whose shape or values the plugin refuses.
    /// </summary>
    public const string InvalidCode = "probe-crashes-invalid";

    /// <summary>
    /// The code of a report larger than <see cref="MaximumByteLength"/>.
    /// </summary>
    public const string SizeCode = "probe-crashes-size";

    /// <summary>
    /// The detail of a report over <see cref="MaximumByteLength"/>.
    /// </summary>
    internal const string SizeDetail = "the report is larger than 64 KiB";

    private const string CrashesPropertyName = "crashes";
    private const string ProbePropertyName = "probe";
    private const string StepsPropertyName = "steps";

    // The report, a crash, and its steps are the only levels
    private static readonly JsonDocumentOptions DocumentOptions = new JsonDocumentOptions
    {
        MaxDepth = 4,
        AllowDuplicateProperties = false
    };

    /// <summary>
    /// Reads a report: 1 to 16 crashes, each a probe of 1 to 64 printable ASCII characters and 0 to 16 steps of 1 to 96, with no other property.
    /// </summary>
    /// <param name="bytes">The report.</param>
    /// <returns>The crashes, or the failed check.</returns>
    public static (IReadOnlyList<ProbeCrash>? Crashes, ReportProblem? Problem) ReadReport(byte[] bytes)
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
            return Refuse<IReadOnlyList<ProbeCrash>>(exception.Message);
        }

        using (document)
        {
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !ReportFunctions.HasOnlyProperties(root, CrashesPropertyName))
            {
                return Refuse<IReadOnlyList<ProbeCrash>>("the report is not an object of 'crashes' only");
            }

            if (!root.TryGetProperty(CrashesPropertyName, out JsonElement crashesElement) || crashesElement.ValueKind != JsonValueKind.Array)
            {
                return Refuse<IReadOnlyList<ProbeCrash>>("'crashes' is not an array");
            }

            int crashCount = crashesElement.GetArrayLength();
            if (crashCount == 0)
            {
                return Refuse<IReadOnlyList<ProbeCrash>>("'crashes' is empty");
            }

            if (crashCount > MaximumCrashCount)
            {
                return Refuse<IReadOnlyList<ProbeCrash>>("more than 16 crashes");
            }

            List<ProbeCrash> crashes = new List<ProbeCrash>(crashCount);
            foreach (JsonElement crashElement in crashesElement.EnumerateArray())
            {
                (ProbeCrash? crash, ReportProblem? problem) = ReadCrash(crashElement);
                if (crash is null)
                {
                    return (null, problem);
                }

                crashes.Add(crash);
            }

            return (crashes, null);
        }
    }

    /// <summary>
    /// Joins a crash's steps for the server log.
    /// </summary>
    /// <param name="steps">The steps.</param>
    /// <returns>The steps, separated by commas, or <see cref="NoSteps"/>.</returns>
    public static string FormatSteps(IReadOnlyList<string> steps)
    {
        ArgumentNullException.ThrowIfNull(steps);
        return steps.Count == 0 ? NoSteps : string.Join(", ", steps);
    }

    private static (ProbeCrash? Crash, ReportProblem? Problem) ReadCrash(JsonElement crashElement)
    {
        if (crashElement.ValueKind != JsonValueKind.Object || !ReportFunctions.HasOnlyProperties(crashElement, ProbePropertyName, StepsPropertyName))
        {
            return Refuse<ProbeCrash>("a crash is not an object of 'probe' and 'steps' only");
        }

        string? probe = crashElement.TryGetProperty(ProbePropertyName, out JsonElement probeElement) ? ReportFunctions.ReadString(probeElement) : null;
        if (probe is null || !ReportFunctions.IsPrintableAscii(probe, MaximumProbeLength))
        {
            return Refuse<ProbeCrash>("a probe is not 1 to 64 printable ASCII characters");
        }

        if (!crashElement.TryGetProperty(StepsPropertyName, out JsonElement stepsElement) || stepsElement.ValueKind != JsonValueKind.Array)
        {
            return Refuse<ProbeCrash>("the steps of '" + probe + "' are not an array");
        }

        if (stepsElement.GetArrayLength() > MaximumStepCount)
        {
            return Refuse<ProbeCrash>("'" + probe + "' has more than 16 steps");
        }

        List<string> steps = new List<string>(stepsElement.GetArrayLength());
        foreach (JsonElement stepElement in stepsElement.EnumerateArray())
        {
            string? step = ReportFunctions.ReadString(stepElement);
            if (step is null || !ReportFunctions.IsPrintableAscii(step, MaximumStepLength))
            {
                return Refuse<ProbeCrash>("a step of '" + probe + "' is not 1 to 96 printable ASCII characters");
            }

            steps.Add(step);
        }

        return (new ProbeCrash(probe, steps), null);
    }

    private static (T? Value, ReportProblem? Problem) Refuse<T>(string detail)
        where T : class
    {
        return (null, new ReportProblem(InvalidCode, detail));
    }
}
