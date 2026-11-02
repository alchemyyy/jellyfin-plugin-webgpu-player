using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Text.Json;

namespace Jellyfin.Plugin.WebGPUPlayer.ClientDefaults;

/// <summary>
/// Reads and writes client defaults documents: <c>{ "settings": { ... }, "apply": [ ... ] }</c> from an administrator, and the data folder's file, which also carries its version and each applied setting's revision.
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
    /// The data folder file format this plugin writes.
    /// </summary>
    public const int StoredVersion = 2;

    /// <summary>
    /// The earlier data folder file format this plugin still reads, which holds no applied revisions.
    /// </summary>
    public const int SettingsOnlyStoredVersion = 1;

    /// <summary>
    /// The detail of a document over <see cref="MaximumByteLength"/>.
    /// </summary>
    internal const string SizeDetail = "the document is larger than 64 KiB";

    private const string VersionPropertyName = "version";
    private const string SettingsPropertyName = "settings";
    private const string ApplyPropertyName = "apply";
    private const string AppliedPropertyName = "applied";

    private static readonly JsonDocumentOptions DocumentOptions = new JsonDocumentOptions
    {
        MaxDepth = MaximumDepth,
        AllowDuplicateProperties = false
    };

    /// <summary>
    /// Reads an administrator's document; a missing <c>apply</c> applies no setting.
    /// </summary>
    /// <param name="bytes">The document.</param>
    /// <returns>The settings and the keys to apply to all clients, or the failed check.</returns>
    public static (IReadOnlyDictionary<string, JsonElement>? Settings, IReadOnlyList<string>? Apply, ClientDefaultsProblem? Problem) ReadDocument(byte[] bytes)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        if (bytes.Length > MaximumByteLength)
        {
            return (null, null, new ClientDefaultsProblem(ClientDefaultsProblem.SizeCode, SizeDetail));
        }

        (JsonDocument? document, ClientDefaultsProblem? problem) = Parse(bytes);
        if (document is null)
        {
            return (null, null, problem);
        }

        using (document)
        {
            JsonElement root = document.RootElement;
            (IReadOnlyDictionary<string, JsonElement>? settings, problem) = ReadSettings(root);
            if (settings is null)
            {
                return (null, null, problem);
            }

            (IReadOnlyList<string>? apply, problem) = ReadApply(root);
            return apply is null ? (null, null, problem) : (settings, apply, null);
        }
    }

    /// <summary>
    /// Reads the data folder's file, which a file of another version fails; a version 1 file holds no applied revisions.
    /// </summary>
    /// <param name="bytes">The file.</param>
    /// <returns>The stored defaults, or the failed check.</returns>
    public static (ClientDefaultsDocument? Document, ClientDefaultsProblem? Problem) ReadStoredFile(byte[] bytes)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        (JsonDocument? document, ClientDefaultsProblem? problem) = Parse(bytes);
        if (document is null)
        {
            return (null, problem);
        }

        using (document)
        {
            JsonElement root = document.RootElement;
            if (!(root.TryGetProperty(VersionPropertyName, out JsonElement version)
                && version.ValueKind == JsonValueKind.Number
                && version.TryGetInt32(out int versionNumber)
                && versionNumber is StoredVersion or SettingsOnlyStoredVersion))
            {
                return Refuse<ClientDefaultsDocument>("the file is of another version");
            }

            (IReadOnlyDictionary<string, JsonElement>? settings, problem) = ReadSettings(root);
            if (settings is null)
            {
                return (null, problem);
            }

            if (versionNumber == SettingsOnlyStoredVersion)
            {
                return (new ClientDefaultsDocument(settings, ReadOnlyDictionary<string, long>.Empty), null);
            }

            (IReadOnlyDictionary<string, long>? applied, problem) = ReadApplied(root);
            return applied is null ? (null, problem) : (new ClientDefaultsDocument(settings, applied), null);
        }
    }

    /// <summary>
    /// Writes the data folder's file of the stored defaults.
    /// </summary>
    /// <param name="document">The stored defaults.</param>
    /// <returns>The file.</returns>
    public static byte[] WriteStoredFile(ClientDefaultsDocument document)
    {
        ArgumentNullException.ThrowIfNull(document);
        using MemoryStream stream = new MemoryStream();
        using (Utf8JsonWriter writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = true }))
        {
            writer.WriteStartObject();
            writer.WriteNumber(VersionPropertyName, StoredVersion);
            writer.WriteStartObject(SettingsPropertyName);
            foreach ((string key, JsonElement value) in document.Settings)
            {
                writer.WritePropertyName(key);
                value.WriteTo(writer);
            }

            writer.WriteEndObject();
            writer.WriteStartObject(AppliedPropertyName);
            foreach ((string key, long revision) in document.Applied)
            {
                writer.WriteNumber(key, revision);
            }

            writer.WriteEndObject();
            writer.WriteEndObject();
        }

        return stream.ToArray();
    }

    /// <summary>
    /// Bumps the revision of each applied key past its previous one and to at least the current time, so revisions keep growing even after the file is reset.
    /// </summary>
    /// <param name="applied">The stored revisions, which stay unchanged.</param>
    /// <param name="apply">The keys to apply to all clients.</param>
    /// <param name="now">The current Unix time, in milliseconds.</param>
    /// <returns>The revisions, with every other key's kept, or the failed check.</returns>
    public static (IReadOnlyDictionary<string, long>? Applied, ClientDefaultsProblem? Problem) Apply(IReadOnlyDictionary<string, long> applied, IReadOnlyList<string> apply, long now)
    {
        ArgumentNullException.ThrowIfNull(applied);
        ArgumentNullException.ThrowIfNull(apply);
        if (apply.Count == 0)
        {
            return (applied, null);
        }

        Dictionary<string, long> bumped = new Dictionary<string, long>(applied, StringComparer.Ordinal);
        foreach (string key in apply)
        {
            long previous = bumped.GetValueOrDefault(key);
            bumped[key] = Math.Max(previous + 1, now);
        }

        return bumped.Count > MaximumSettingCount
            ? Refuse<IReadOnlyDictionary<string, long>>("more than 64 applied settings")
            : (bumped, null);
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

    /// <summary>
    /// Parses a document whose root is an object; the caller disposes it.
    /// </summary>
    private static (JsonDocument? Document, ClientDefaultsProblem? Problem) Parse(byte[] bytes)
    {
        JsonDocument document;
        try
        {
            // Strict JSON: no comments, trailing commas, or duplicate properties, and nesting no deeper than the limit
            document = JsonDocument.Parse(bytes, DocumentOptions);
        }
        catch (JsonException exception)
        {
            return Refuse<JsonDocument>(exception.Message);
        }

        if (document.RootElement.ValueKind != JsonValueKind.Object)
        {
            document.Dispose();
            return Refuse<JsonDocument>("the document is not an object");
        }

        return (document, null);
    }

    private static (IReadOnlyDictionary<string, JsonElement>? Settings, ClientDefaultsProblem? Problem) ReadSettings(JsonElement root)
    {
        if (!root.TryGetProperty(SettingsPropertyName, out JsonElement settingsElement) || settingsElement.ValueKind != JsonValueKind.Object)
        {
            return Refuse<IReadOnlyDictionary<string, JsonElement>>("'settings' is not an object");
        }

        Dictionary<string, JsonElement> settings = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (JsonProperty setting in settingsElement.EnumerateObject())
        {
            if (settings.Count == MaximumSettingCount)
            {
                return Refuse<IReadOnlyDictionary<string, JsonElement>>("more than 64 settings");
            }

            if (!IsSettingKey(setting.Name))
            {
                return Refuse<IReadOnlyDictionary<string, JsonElement>>("the key '" + setting.Name + "'");
            }

            if (setting.Value.ValueKind == JsonValueKind.Null)
            {
                return Refuse<IReadOnlyDictionary<string, JsonElement>>("'" + setting.Name + "' is null");
            }

            // The clone outlives the document; a key spelled once escaped and once not is a duplicate too
            if (!settings.TryAdd(setting.Name, setting.Value.Clone()))
            {
                return Refuse<IReadOnlyDictionary<string, JsonElement>>("the key '" + setting.Name + "' repeats");
            }
        }

        return (settings, null);
    }

    private static (IReadOnlyList<string>? Apply, ClientDefaultsProblem? Problem) ReadApply(JsonElement root)
    {
        if (!root.TryGetProperty(ApplyPropertyName, out JsonElement applyElement))
        {
            return (Array.Empty<string>(), null);
        }

        if (applyElement.ValueKind != JsonValueKind.Array)
        {
            return Refuse<IReadOnlyList<string>>("'apply' is not an array");
        }

        List<string> apply = new List<string>();
        HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonElement keyElement in applyElement.EnumerateArray())
        {
            if (apply.Count == MaximumSettingCount)
            {
                return Refuse<IReadOnlyList<string>>("more than 64 apply keys");
            }

            if (keyElement.ValueKind != JsonValueKind.String)
            {
                return Refuse<IReadOnlyList<string>>("the apply key " + keyElement.GetRawText());
            }

            string key = keyElement.GetString()!;
            if (!IsSettingKey(key))
            {
                return Refuse<IReadOnlyList<string>>("the apply key '" + key + "'");
            }

            if (!seen.Add(key))
            {
                return Refuse<IReadOnlyList<string>>("the apply key '" + key + "' repeats");
            }

            apply.Add(key);
        }

        return (apply, null);
    }

    private static (IReadOnlyDictionary<string, long>? Applied, ClientDefaultsProblem? Problem) ReadApplied(JsonElement root)
    {
        if (!root.TryGetProperty(AppliedPropertyName, out JsonElement appliedElement) || appliedElement.ValueKind != JsonValueKind.Object)
        {
            return Refuse<IReadOnlyDictionary<string, long>>("'applied' is not an object");
        }

        Dictionary<string, long> applied = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (JsonProperty revision in appliedElement.EnumerateObject())
        {
            if (applied.Count == MaximumSettingCount)
            {
                return Refuse<IReadOnlyDictionary<string, long>>("more than 64 applied settings");
            }

            if (!IsSettingKey(revision.Name))
            {
                return Refuse<IReadOnlyDictionary<string, long>>("the applied key '" + revision.Name + "'");
            }

            if (!(revision.Value.ValueKind == JsonValueKind.Number && revision.Value.TryGetInt64(out long number) && number > 0))
            {
                return Refuse<IReadOnlyDictionary<string, long>>("the revision of '" + revision.Name + "' is not a positive integer");
            }

            if (!applied.TryAdd(revision.Name, number))
            {
                return Refuse<IReadOnlyDictionary<string, long>>("the applied key '" + revision.Name + "' repeats");
            }
        }

        return (applied, null);
    }

    private static (T? Value, ClientDefaultsProblem? Problem) Refuse<T>(string detail)
        where T : class
    {
        return (null, new ClientDefaultsProblem(ClientDefaultsProblem.InvalidCode, detail));
    }
}
