using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Text.Json;
using System.Threading;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.WebGPUPlayer.ClientDefaults;

/// <summary>
/// The defaults an administrator sets for the add-on's client settings; a user's own choice wins over them.
/// They live in the plugin's data folder, so they survive plugin updates.
/// </summary>
public sealed class ClientDefaultsStore
{
    /// <summary>
    /// The data folder's file of client defaults.
    /// </summary>
    public const string FileName = "client-defaults.json";

    private const string TemporaryFileExtension = ".tmp";

    private static readonly ClientDefaultsDocument NoDefaults = new ClientDefaultsDocument(
        ReadOnlyDictionary<string, JsonElement>.Empty,
        ReadOnlyDictionary<string, long>.Empty);

    private readonly Lock sync = new();
    private readonly string filePath;
    private readonly ILogger<ClientDefaultsStore> logger;
    private readonly TimeProvider timeProvider;
    private ClientDefaultsDocument document;

    /// <summary>
    /// Initializes a new instance of the <see cref="ClientDefaultsStore"/> class, reading the defaults in the data folder.
    /// </summary>
    /// <param name="dataFolderPath">The plugin's data folder.</param>
    /// <param name="logger">The logger.</param>
    /// <param name="timeProvider">The clock applied revisions follow; the system clock when omitted.</param>
    public ClientDefaultsStore(string dataFolderPath, ILogger<ClientDefaultsStore> logger, TimeProvider? timeProvider = null)
    {
        this.logger = logger;
        this.timeProvider = timeProvider ?? TimeProvider.System;
        filePath = Path.Combine(dataFolderPath, FileName);
        document = Load();
    }

    /// <summary>
    /// Gets the stored defaults.
    /// </summary>
    /// <returns>The default of each setting an administrator set and the revision of each setting applied to all clients, by its flat key.</returns>
    public ClientDefaultsDocument GetDocument()
    {
        lock (sync)
        {
            return document;
        }
    }

    /// <summary>
    /// Replaces the stored defaults with an administrator's document, <c>{ "settings": { ... }, "apply": [ ... ] }</c>, and bumps the revision of each applied key.
    /// </summary>
    /// <param name="bytes">The document.</param>
    /// <returns>The stored defaults, or the failed check.</returns>
    public (ClientDefaultsDocument? Document, ClientDefaultsProblem? Problem) SetDocument(byte[] bytes)
    {
        (IReadOnlyDictionary<string, JsonElement>? settings, IReadOnlyList<string>? apply, ClientDefaultsProblem? problem) = ClientDefaultsFunctions.ReadDocument(bytes);
        if (settings is null || apply is null)
        {
            return (null, problem);
        }

        lock (sync)
        {
            // The bump reads the revisions under the lock, so concurrent applies never lose one
            (IReadOnlyDictionary<string, long>? applied, problem) = ClientDefaultsFunctions.Apply(
                document.Applied,
                apply,
                timeProvider.GetUtcNow().ToUnixTimeMilliseconds());
            if (applied is null)
            {
                return (null, problem);
            }

            ClientDefaultsDocument stored = new ClientDefaultsDocument(settings, applied);
            ClientDefaultsProblem? writeProblem = WriteFile(ClientDefaultsFunctions.WriteStoredFile(stored));
            if (writeProblem is not null)
            {
                return (null, writeProblem);
            }

            document = stored;
            return (stored, null);
        }
    }

    /// <summary>
    /// Reads the data folder's file; a missing, unreadable, or other-version file is no defaults.
    /// </summary>
    private ClientDefaultsDocument Load()
    {
        if (!File.Exists(filePath))
        {
            return NoDefaults;
        }

        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(filePath);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            logger.LogWarning(exception, "WebGPU Player could not read {Path}; clients get no defaults", filePath);
            return NoDefaults;
        }

        (ClientDefaultsDocument? read, ClientDefaultsProblem? problem) = ClientDefaultsFunctions.ReadStoredFile(bytes);
        if (read is null)
        {
            logger.LogWarning("WebGPU Player client defaults {Path} do not read: {Problem}; clients get no defaults", filePath, problem?.ToString());
            return NoDefaults;
        }

        return read;
    }

    /// <summary>
    /// Writes the file through a temporary sibling, so a reader or a restart never sees part of it.
    /// </summary>
    private ClientDefaultsProblem? WriteFile(byte[] bytes)
    {
        string temporaryPath = filePath + TemporaryFileExtension;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(filePath)!);
            File.WriteAllBytes(temporaryPath, bytes);
            File.Move(temporaryPath, filePath, overwrite: true);
            return null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            logger.LogWarning(exception, "WebGPU Player could not write {Path}", filePath);
            return new ClientDefaultsProblem(ClientDefaultsProblem.WriteFailedCode, exception.Message);
        }
    }
}
