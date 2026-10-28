using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace Jellyfin.Plugin.WebGPUPlayer.ClientDefaults;

/// <summary>
/// Reads and writes client defaults documents: <c>{ "settings": { ... } }</c> from an administrator, and the data folder's file, which also carries its version.
/// Only the document's shape is checked; each value is kept verbatim, since the add-on normalizes every setting as it normalizes a user's stored choice.
/// </summary>
public static class ClientDefaultsFunctions
{
    /// <summary>
    /// The largest administrator's document, in bytes.
    /// </summary>
    public const int MaximumByteLength = 64 * 1024;

    /// <summary>
    /// The deepest nesting of objects and arrays a document may hold, its root included.
    /// </summary>
    public const int MaximumDepth = 16;

    /// <summary>
    /// The most settings a document may hold.
    /// </summary>
    public const int MaximumSettingCount = 64;

    /// <summary>
    /// The longest setting key.
    /// </summary>
    public const int MaximumKeyLength = 64;

    /// <summary>
    /// The data folder file format this plugin reads and writes.
    /// </summary>
    public const int StoredVersion = 1;

    /// <summary>
    /// The detail of a document over <see cref="MaximumByteLength"/>.
    /// </summary>
    internal const string SizeDetail = "the document is larger than 64 KiB";

    private const string VersionPropertyName = "version";
    private const string SettingsPropertyName = "settings";

    private static readonly JsonDocumentOptions DocumentOptions = new JsonDocumentOptions
    {
        MaxDepth = MaximumDepth,
        AllowDuplicateProperties = false
    };

    /// <summary>
    /// Reads an administrator's document.
    /// </summary>
    /// <param name="bytes">The document.</param>
    /// <returns>The settings, or the failed check.</returns>
    public static (IReadOnlyDictionary<string, JsonElement>? Settings, ClientDefaultsProblem? Problem) ReadDocument(byte[] bytes)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        return bytes.Length > MaximumByteLength
            ? (null, new ClientDefaultsProblem(ClientDefaultsProblem.SizeCode, SizeDetail))
            : ReadSettings(bytes, false);
    }

    /// <summary>
    /// Reads the data folder's file, which a file of another version fails.
    /// </summary>
    /// <param name="bytes">The file.</param>
    /// <returns>The settings, or the failed check.</returns>
    public static (IReadOnlyDictionary<string, JsonElement>? Settings, ClientDefaultsProblem? Problem) ReadStoredFile(byte[] bytes)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        return ReadSettings(bytes, true);
    }

    /// <summary>
    /// Writes the data folder's file of settings.
    /// </summary>
    /// <param name="settings">The settings.</param>
    /// <returns>The file.</returns>
    public static byte[] WriteStoredFile(IReadOnlyDictionary<string, JsonElement> settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        using MemoryStream stream = new MemoryStream();
        using (Utf8JsonWriter writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = true }))
        {
            writer.WriteStartObject();
            writer.WriteNumber(VersionPropertyName, StoredVersion);
            writer.WriteStartObject(SettingsPropertyName);
            foreach ((string key, JsonElement value) in settings)
            {
                writer.WritePropertyName(key);
                value.WriteTo(writer);
            }

            writer.WriteEndObject();
            writer.WriteEndObject();
        }

        return stream.ToArray();
    }

    /// <summary>
    /// Returns whether a setting key is an ASCII letter followed by up to 63 ASCII letters and digits.
    /// </summary>
    /// <param name="key">The key.</param>
    /// <returns>Whether the key is allowed.</returns>
    public static bool IsSettingKey(string key)
    {
        ArgumentNullException.ThrowIfNull(key);
        if (key.Length == 0 || key.Length > MaximumKeyLength || !char.IsAsciiLetter(key[0]))
        {
            return false;
        }

        foreach (char character in key)
        {
            if (!char.IsAsciiLetterOrDigit(character))
            {
                return false;
            }
        }

        return true;
    }

    private static (IReadOnlyDictionary<string, JsonElement>? Settings, ClientDefaultsProblem? Problem) ReadSettings(byte[] bytes, bool stored)
    {
        JsonDocument document;
        try
        {
            // Strict JSON: no comments, trailing commas, or duplicate properties, and nesting no deeper than the limit
            document = JsonDocument.Parse(bytes, DocumentOptions);
        }
        catch (JsonException exception)
        {
            return Refuse(exception.Message);
        }

        using (document)
        {
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return Refuse("the document is not an object");
            }

            if (stored && !(root.TryGetProperty(VersionPropertyName, out JsonElement version)
                && version.ValueKind == JsonValueKind.Number
                && version.TryGetInt32(out int versionNumber)
                && versionNumber == StoredVersion))
            {
                return Refuse("the file is of another version");
            }

            if (!root.TryGetProperty(SettingsPropertyName, out JsonElement settingsElement) || settingsElement.ValueKind != JsonValueKind.Object)
            {
                return Refuse("'settings' is not an object");
            }

            Dictionary<string, JsonElement> settings = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            foreach (JsonProperty setting in settingsElement.EnumerateObject())
            {
                if (settings.Count == MaximumSettingCount)
                {
                    return Refuse("more than 64 settings");
                }

                if (!IsSettingKey(setting.Name))
                {
                    return Refuse("the key '" + setting.Name + "'");
                }

                if (setting.Value.ValueKind == JsonValueKind.Null)
                {
                    return Refuse("'" + setting.Name + "' is null");
                }

                // The clone outlives the document; a key spelled once escaped and once not is a duplicate too
                if (!settings.TryAdd(setting.Name, setting.Value.Clone()))
                {
                    return Refuse("the key '" + setting.Name + "' repeats");
                }
            }

            return (settings, null);
        }
    }

    private static (IReadOnlyDictionary<string, JsonElement>? Settings, ClientDefaultsProblem? Problem) Refuse(string detail)
    {
        return (null, new ClientDefaultsProblem(ClientDefaultsProblem.InvalidCode, detail));
    }
}
