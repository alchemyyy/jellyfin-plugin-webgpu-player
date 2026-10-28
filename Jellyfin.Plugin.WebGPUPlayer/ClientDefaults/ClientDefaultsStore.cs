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

    private readonly Lock sync = new();
    private readonly string filePath;
    private readonly ILogger<ClientDefaultsStore> logger;
    private IReadOnlyDictionary<string, JsonElement> settings;

    /// <summary>
    /// Initializes a new instance of the <see cref="ClientDefaultsStore"/> class, reading the defaults in the data folder.
    /// </summary>
    /// <param name="dataFolderPath">The plugin's data folder.</param>
    /// <param name="logger">The logger.</param>
    public ClientDefaultsStore(string dataFolderPath, ILogger<ClientDefaultsStore> logger)
    {
        this.logger = logger;
        filePath = Path.Combine(dataFolderPath, FileName);
        settings = Load();
    }

    /// <summary>
    /// Gets the stored defaults.
    /// </summary>
    /// <returns>The default of each setting an administrator set, by its flat key.</returns>
    public IReadOnlyDictionary<string, JsonElement> GetSettings()
    {
        lock (sync)
        {
            return settings;
        }
    }

    /// <summary>
    /// Replaces the stored defaults with an administrator's document, <c>{ "settings": { ... } }</c>.
    /// </summary>
    /// <param name="bytes">The document.</param>
    /// <returns>The stored defaults, or the failed check.</returns>
    public (IReadOnlyDictionary<string, JsonElement>? Settings, ClientDefaultsProblem? Problem) SetDocument(byte[] bytes)
    {
        (IReadOnlyDictionary<string, JsonElement>? read, ClientDefaultsProblem? problem) = ClientDefaultsFunctions.ReadDocument(bytes);
        if (read is null)
        {
            return (null, problem);
        }

        byte[] file = ClientDefaultsFunctions.WriteStoredFile(read);
        lock (sync)
        {
            ClientDefaultsProblem? writeProblem = WriteFile(file);
            if (writeProblem is not null)
            {
                return (null, writeProblem);
            }

            settings = read;
            return (read, null);
        }
    }

    /// <summary>
    /// Reads the data folder's file; a missing, unreadable, or other-version file is no defaults.
    /// </summary>
    private IReadOnlyDictionary<string, JsonElement> Load()
    {
        if (!File.Exists(filePath))
        {
            return ReadOnlyDictionary<string, JsonElement>.Empty;
        }

        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(filePath);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            logger.LogWarning(exception, "WebGPU Player could not read {Path}; clients get no defaults", filePath);
            return ReadOnlyDictionary<string, JsonElement>.Empty;
        }

        (IReadOnlyDictionary<string, JsonElement>? read, ClientDefaultsProblem? problem) = ClientDefaultsFunctions.ReadStoredFile(bytes);
        if (read is null)
        {
            logger.LogWarning("WebGPU Player client defaults {Path} do not read: {Problem}; clients get no defaults", filePath, problem?.ToString());
            return ReadOnlyDictionary<string, JsonElement>.Empty;
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
