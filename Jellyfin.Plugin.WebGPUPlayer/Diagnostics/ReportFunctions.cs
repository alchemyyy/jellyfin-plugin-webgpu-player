using System;
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;

namespace Jellyfin.Plugin.WebGPUPlayer.Diagnostics;

/// <summary>
/// What every client report to the diagnostics routes shares: the check of its strings, the reads of its JSON, and its sender, described for the server log.
/// </summary>
public static class ReportFunctions
{
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
    public static ClientReporter ReadReporter(string? userAgent, string? authorization, string? embyAuthorization)
    {
        (string? Client, string? Version, string? Device) first = ReadClientFields(authorization);
        (string? Client, string? Version, string? Device) second = ReadClientFields(embyAuthorization);
        return new ClientReporter(
            first.Client ?? second.Client ?? Unknown,
            first.Version ?? second.Version ?? Unknown,
            first.Device ?? second.Device ?? Unknown,
            Clean(userAgent, MaximumUserAgentLength) ?? Unknown);
    }

    /// <summary>
    /// Returns whether an object has no property but the named ones.
    /// </summary>
    /// <param name="element">The object.</param>
    /// <param name="names">The names it may have.</param>
    /// <returns>Whether every property is named.</returns>
    internal static bool HasOnlyProperties(JsonElement element, params ReadOnlySpan<string> names)
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

    /// <summary>
    /// Reads a JSON string.
    /// </summary>
    /// <param name="element">The value.</param>
    /// <returns>The string, or null when the value is no string or no valid one.</returns>
    internal static string? ReadString(JsonElement element)
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
}
