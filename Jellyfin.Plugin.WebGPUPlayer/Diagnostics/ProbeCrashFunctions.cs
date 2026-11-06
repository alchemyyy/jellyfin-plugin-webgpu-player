using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;

namespace Jellyfin.Plugin.WebGPUPlayer.Diagnostics;

/// <summary>
/// Reads a client's report of the capability probes that stopped its pages, <c>{ "crashes": [ { "probe": "...", "steps": [ "..." ] } ] }</c>, and describes its sender for the server log.
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
    /// The longest User-Agent the log keeps; a longer one is cut.
    /// </summary>
    public const int MaximumUserAgentLength = 256;

    /// <summary>
    /// The longest Jellyfin client name, client version, or device name the log keeps; a longer one is cut.
    /// </summary>
    public const int MaximumClientFieldLength = 64;

    /// <summary>
    /// What the log names a client, client version, device, or browser the request does not carry.
    /// </summary>
    public const string Unknown = "unknown";

    /// <summary>
    /// What the log names the steps of a crash whose page recorded none.
    /// </summary>
    public const string NoSteps = "no recorded call";

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
    public static (IReadOnlyList<ProbeCrash>? Crashes, ProbeCrashProblem? Problem) ReadReport(byte[] bytes)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        if (bytes.Length > MaximumByteLength)
        {
            return (null, new ProbeCrashProblem(ProbeCrashProblem.SizeCode, SizeDetail));
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
            if (root.ValueKind != JsonValueKind.Object || !HasOnlyProperties(root, CrashesPropertyName))
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
                (ProbeCrash? crash, ProbeCrashProblem? problem) = ReadCrash(crashElement);
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
    /// Returns whether a value is 1 to <paramref name="maximumLength"/> printable ASCII characters, 0x20 to 0x7E.
    /// </summary>
    /// <param name="value">The value.</param>
    /// <param name="maximumLength">The longest value allowed.</param>
    /// <returns>Whether the value is allowed.</returns>
    public static bool IsPrintableAscii(string value, int maximumLength)
    {
        ArgumentNullException.ThrowIfNull(value);
        if (value.Length == 0 || value.Length > maximumLength)
        {
            return false;
        }

        foreach (char character in value)
        {
            if (character is < ' ' or > '~')
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Describes the sender of a report from its headers: the browser from its User-Agent, and the Jellyfin client, client version, and device from the first Jellyfin authorization header that names each.
    /// Only those parts are read; the token, the device id, and every other part of a header are dropped.
    /// </summary>
    /// <param name="userAgent">The User-Agent header.</param>
    /// <param name="authorization">The Authorization header.</param>
    /// <param name="embyAuthorization">The X-Emby-Authorization header.</param>
    /// <returns>The sender, each part without control characters, cut to its limit, or <see cref="Unknown"/>.</returns>
    public static ProbeCrashReporter ReadReporter(string? userAgent, string? authorization, string? embyAuthorization)
    {
        (string? Client, string? Version, string? Device) first = ReadClientFields(authorization);
        (string? Client, string? Version, string? Device) second = ReadClientFields(embyAuthorization);
        return new ProbeCrashReporter(
            first.Client ?? second.Client ?? Unknown,
            first.Version ?? second.Version ?? Unknown,
            first.Device ?? second.Device ?? Unknown,
            Clean(userAgent, MaximumUserAgentLength) ?? Unknown);
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

    private static (ProbeCrash? Crash, ProbeCrashProblem? Problem) ReadCrash(JsonElement crashElement)
    {
        if (crashElement.ValueKind != JsonValueKind.Object || !HasOnlyProperties(crashElement, ProbePropertyName, StepsPropertyName))
        {
            return Refuse<ProbeCrash>("a crash is not an object of 'probe' and 'steps' only");
        }

        string? probe = crashElement.TryGetProperty(ProbePropertyName, out JsonElement probeElement) ? ReadString(probeElement) : null;
        if (probe is null || !IsPrintableAscii(probe, MaximumProbeLength))
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
            string? step = ReadString(stepElement);
            if (step is null || !IsPrintableAscii(step, MaximumStepLength))
            {
                return Refuse<ProbeCrash>("a step of '" + probe + "' is not 1 to 96 printable ASCII characters");
            }

            steps.Add(step);
        }

        return (new ProbeCrash(probe, steps), null);
    }

    private static bool HasOnlyProperties(JsonElement element, params ReadOnlySpan<string> names)
    {
        foreach (JsonProperty property in element.EnumerateObject())
        {
            bool known = false;
            foreach (string name in names)
            {
                known |= property.NameEquals(name);
            }

            if (!known)
            {
                return false;
            }
        }

        return true;
    }

    private static string? ReadString(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        try
        {
            return element.GetString();
        }
        catch (InvalidOperationException)
        {
            // An escaped lone surrogate is valid JSON but no valid string
            return null;
        }
    }

    // Reads the client parts of a Jellyfin authorization header, MediaBrowser Client="...", Device="...", DeviceId="...", Version="...", Token="..."
    private static (string? Client, string? Version, string? Device) ReadClientFields(string? header)
    {
        if (string.IsNullOrEmpty(header))
        {
            return (null, null, null);
        }

        int schemeEnd = header.IndexOf(' ', StringComparison.Ordinal);
        if (schemeEnd < 0)
        {
            return (null, null, null);
        }

        string scheme = header[..schemeEnd];
        if (!scheme.Equals("MediaBrowser", StringComparison.OrdinalIgnoreCase) && !scheme.Equals("Emby", StringComparison.OrdinalIgnoreCase))
        {
            return (null, null, null);
        }

        string? client = null;
        string? version = null;
        string? device = null;
        foreach (string part in header[(schemeEnd + 1)..].Split(','))
        {
            int separator = part.IndexOf('=', StringComparison.Ordinal);
            if (separator <= 0)
            {
                continue;
            }

            string key = part[..separator].Trim();
            if (key.Equals("Client", StringComparison.OrdinalIgnoreCase))
            {
                client = ReadClientField(part[(separator + 1)..]);
            }
            else if (key.Equals("Version", StringComparison.OrdinalIgnoreCase))
            {
                version = ReadClientField(part[(separator + 1)..]);
            }
            else if (key.Equals("Device", StringComparison.OrdinalIgnoreCase))
            {
                device = ReadClientField(part[(separator + 1)..]);
            }
        }

        return (client, version, device);
    }

    // Jellyfin clients URL-encode each value, as the server decodes it
    private static string? ReadClientField(string value)
    {
        return Clean(WebUtility.UrlDecode(value.Trim().Trim('"')), MaximumClientFieldLength);
    }

    // Drops the characters that could forge or hide a log line, cuts the value to its limit, and trims it
    private static string? Clean(string? value, int maximumLength)
    {
        if (value is null)
        {
            return null;
        }

        StringBuilder cleaned = new StringBuilder(Math.Min(value.Length, maximumLength));
        foreach (char character in value)
        {
            if (cleaned.Length == maximumLength)
            {
                break;
            }

            if (char.GetUnicodeCategory(character) is not (UnicodeCategory.Control or UnicodeCategory.Format or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator or UnicodeCategory.Surrogate))
            {
                cleaned.Append(character);
            }
        }

        string result = cleaned.ToString().Trim();
        return result.Length == 0 ? null : result;
    }

    private static (T? Value, ProbeCrashProblem? Problem) Refuse<T>(string detail)
        where T : class
    {
        return (null, new ProbeCrashProblem(ProbeCrashProblem.InvalidCode, detail));
    }
}
