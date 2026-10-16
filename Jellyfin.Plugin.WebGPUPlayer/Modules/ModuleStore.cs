using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading;
using Jellyfin.Plugin.WebGPUPlayer.Addon;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.WebGPUPlayer.Modules;

/// <summary>
/// The decoder packages and pass files the plugin offers to clients: the ones the add-on build carries, the ones an administrator uploads, and the keys disabled.
/// An upload of a bundled file's key replaces it, as a new version of a decoder package replaces the old one, and removing the upload restores it.
/// Uploads and the disabled keys live in the plugin's data folder, so they survive plugin updates.
/// </summary>
public sealed class ModuleStore
{
    /// <summary>
    /// The data folder's subfolder of uploaded decoder packages.
    /// </summary>
    public const string DecoderPackageFolderName = "wgpud";

    /// <summary>
    /// The data folder's subfolder of uploaded pass files.
    /// </summary>
    public const string PassFolderName = "wgpup";

    /// <summary>
    /// The data folder's file of disabled keys.
    /// </summary>
    public const string StateFileName = "state.json";

    /// <summary>
    /// The source of a module file the plugin carries.
    /// </summary>
    public const string BundledSource = "bundled";

    /// <summary>
    /// The source of a module file an administrator uploaded.
    /// </summary>
    public const string UploadedSource = "uploaded";

    /// <summary>
    /// The state format this store reads and writes.
    /// </summary>
    public const int StateVersion = 1;

    private const string TemporaryFileExtension = ".tmp";
    private const string SectionUnknownCode = "package-section-unknown";
    private const string IdMismatchCode = "package-id-mismatch";
    private const string KeyDuplicateCode = "module-key-duplicate";

    private static readonly JsonSerializerOptions StateJsonOptions = new JsonSerializerOptions
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true
    };

    private readonly Lock sync = new();
    private readonly string stateFilePath;
    private readonly string? decoderPackageSection;
    private readonly ILogger<ModuleStore> logger;
    private readonly ModuleShelf<DecoderPackageInfo> decoderPackages;
    private readonly ModuleShelf<PassFileInfo> passes;

    /// <summary>
    /// Initializes a new instance of the <see cref="ModuleStore"/> class, reading the uploads and the state in the data folder.
    /// </summary>
    /// <param name="dataFolderPath">The plugin's data folder.</param>
    /// <param name="decoderPackageSection">The custom section that carries a package's header, or <c>null</c> when the add-on names none, which leaves every package unread.</param>
    /// <param name="bundledDecoderPackageFiles">The decoder packages the plugin carries, in the order clients get them.</param>
    /// <param name="bundledPassFiles">The pass files the plugin carries, in the order clients get them.</param>
    /// <param name="logger">The logger.</param>
    public ModuleStore(
        string dataFolderPath,
        string? decoderPackageSection,
        IReadOnlyList<(string FileName, byte[] Bytes)> bundledDecoderPackageFiles,
        IReadOnlyList<(string FileName, byte[] Bytes)> bundledPassFiles,
        ILogger<ModuleStore> logger)
    {
        ArgumentNullException.ThrowIfNull(bundledDecoderPackageFiles);
        ArgumentNullException.ThrowIfNull(bundledPassFiles);
        this.decoderPackageSection = decoderPackageSection;
        this.logger = logger;
        stateFilePath = Path.Combine(dataFolderPath, StateFileName);
        decoderPackages = new ModuleShelf<DecoderPackageInfo>(Path.Combine(dataFolderPath, DecoderPackageFolderName), StringComparer.Ordinal);
        passes = new ModuleShelf<PassFileInfo>(Path.Combine(dataFolderPath, PassFolderName), StringComparer.OrdinalIgnoreCase);

        foreach ((string fileName, byte[] bytes) in bundledDecoderPackageFiles)
        {
            (DecoderPackageInfo? package, ModuleProblem? problem) = ReadDecoderPackage(bytes);
            AddBundled(decoderPackages, package?.Id ?? Path.GetFileNameWithoutExtension(fileName), fileName, bytes, package, problem);
        }

        foreach ((string fileName, byte[] bytes) in bundledPassFiles)
        {
            (PassFileInfo? file, ModuleProblem? problem) = PassFileFunctions.ReadPassFile(fileName, bytes);
            AddBundled(passes, fileName, fileName, bytes, file, problem);
        }

        LoadUploadedDecoderPackages();
        LoadUploadedPasses();
        LoadState();
    }

    /// <summary>
    /// Opens the store of a data folder with the modules the embedded add-on carries.
    /// </summary>
    /// <param name="dataFolderPath">The plugin's data folder.</param>
    /// <param name="logger">The logger.</param>
    /// <returns>The store.</returns>
    public static ModuleStore OpenBundled(string dataFolderPath, ILogger<ModuleStore> logger)
    {
        AddonModules modules = AddonCatalog.Modules;
        if (modules.Problem is not null)
        {
            logger.LogWarning("WebGPU Player add-on manifest lists its modules wrongly: {Problem}", modules.Problem);
        }

        return new ModuleStore(
            dataFolderPath,
            modules.DecoderPackageSection,
            ReadBundledFiles(modules.DecoderPackagePaths),
            ReadBundledFiles(modules.PassPaths),
            logger);
    }

    /// <summary>
    /// Gets the decoder packages and pass files clients get.
    /// </summary>
    /// <returns>The catalog.</returns>
    public ModuleCatalog GetCatalog()
    {
        lock (sync)
        {
            return new ModuleCatalog(ListOffered(decoderPackages), ListOffered(passes));
        }
    }

    /// <summary>
    /// Gets every module file the store holds, for the settings page.
    /// </summary>
    /// <returns>The listing.</returns>
    public ModuleListing GetListing()
    {
        lock (sync)
        {
            return new ModuleListing(ListEntries(decoderPackages), ListEntries(passes));
        }
    }

    /// <summary>
    /// Gets the offered decoder package of an id.
    /// </summary>
    /// <param name="id">The package id.</param>
    /// <returns>The package file and its content hash, or <c>null</c> when no package of the id is offered.</returns>
    public (byte[] Bytes, string ContentHash)? GetOfferedDecoderPackage(string id)
    {
        lock (sync)
        {
            StoredModule<DecoderPackageInfo>? module = FindOffered(decoderPackages, id);
            return module?.Info is null ? null : (module.Bytes, module.Info.ContentHash);
        }
    }

    /// <summary>
    /// Gets the offered pass file of a name.
    /// </summary>
    /// <param name="fileName">The pass file name.</param>
    /// <returns>The pass file and its content hash, or <c>null</c> when no pass file of the name is offered.</returns>
    public (byte[] Bytes, string ContentHash)? GetOfferedPass(string fileName)
    {
        lock (sync)
        {
            StoredModule<PassFileInfo>? module = FindOffered(passes, fileName);
            return module?.Info is null ? null : (module.Bytes, module.Info.ContentHash);
        }
    }

    /// <summary>
    /// Stores an uploaded decoder package under the id its header declares, replacing an upload or a bundled package of that id.
    /// </summary>
    /// <param name="bytes">The package file.</param>
    /// <returns>The check the file failed, or <c>null</c> once it is stored.</returns>
    public ModuleProblem? AddDecoderPackage(byte[] bytes)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        (DecoderPackageInfo? package, ModuleProblem? problem) = ReadDecoderPackage(bytes);
        if (package is null)
        {
            return problem;
        }

        lock (sync)
        {
            return AddUpload(decoderPackages, package.Id, package.Id + DecoderPackageFunctions.FileExtension, bytes, package);
        }
    }

    /// <summary>
    /// Stores an uploaded pass file under its name, replacing an upload or a bundled file of that name.
    /// </summary>
    /// <param name="fileName">The pass file name.</param>
    /// <param name="bytes">The pass file.</param>
    /// <returns>The check the file failed, or <c>null</c> once it is stored.</returns>
    public ModuleProblem? AddPass(string fileName, byte[] bytes)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        (PassFileInfo? file, ModuleProblem? problem) = PassFileFunctions.ReadPassFile(fileName, bytes);
        if (file is null)
        {
            return problem;
        }

        lock (sync)
        {
            return AddUpload(passes, fileName, fileName, bytes, file);
        }
    }

    /// <summary>
    /// Deletes the uploaded decoder package of an id, which restores a bundled package of that id.
    /// </summary>
    /// <param name="id">The package id.</param>
    /// <returns>The failure, or <c>null</c> once the upload is gone.</returns>
    public ModuleProblem? RemoveDecoderPackage(string id)
    {
        lock (sync)
        {
            return RemoveUpload(decoderPackages, id);
        }
    }

    /// <summary>
    /// Deletes the uploaded pass file of a name, which restores a bundled file of that name.
    /// </summary>
    /// <param name="fileName">The pass file name.</param>
    /// <returns>The failure, or <c>null</c> once the upload is gone.</returns>
    public ModuleProblem? RemovePass(string fileName)
    {
        lock (sync)
        {
            return RemoveUpload(passes, fileName);
        }
    }

    /// <summary>
    /// Enables or disables the decoder package id, whichever version holds it.
    /// </summary>
    /// <param name="id">The package id.</param>
    /// <param name="enabled">Whether clients get the package.</param>
    /// <returns>The failure, or <c>null</c> once the state is stored.</returns>
    public ModuleProblem? SetDecoderPackageEnabled(string id, bool enabled)
    {
        lock (sync)
        {
            return SetEnabled(decoderPackages, id, enabled);
        }
    }

    /// <summary>
    /// Enables or disables the pass file name, whichever version holds it.
    /// </summary>
    /// <param name="fileName">The pass file name.</param>
    /// <param name="enabled">Whether clients get the pass file.</param>
    /// <returns>The failure, or <c>null</c> once the state is stored.</returns>
    public ModuleProblem? SetPassEnabled(string fileName, bool enabled)
    {
        lock (sync)
        {
            return SetEnabled(passes, fileName, enabled);
        }
    }

    private static List<(string FileName, byte[] Bytes)> ReadBundledFiles(IReadOnlyList<string> paths)
    {
        List<(string FileName, byte[] Bytes)> files = [];
        foreach (string path in paths)
        {
            // The manifest parse kept only embedded paths
            using Stream? stream = AddonCatalog.OpenAsset(path);
            if (stream is null)
            {
                continue;
            }

            using MemoryStream copy = new MemoryStream();
            stream.CopyTo(copy);
            files.Add((Path.GetFileName(path), copy.ToArray()));
        }

        return files;
    }

    private static List<ModuleListingEntry<TInfo>> ListEntries<TInfo>(ModuleShelf<TInfo> shelf)
        where TInfo : class
    {
        List<ModuleListingEntry<TInfo>> entries = [];
        foreach (StoredModule<TInfo> module in shelf.Bundled)
        {
            bool enabled = !shelf.Disabled.Contains(module.Key);
            bool replaced = shelf.Uploaded.ContainsKey(module.Key);
            entries.Add(new ModuleListingEntry<TInfo>(
                module.Key,
                module.FileName,
                BundledSource,
                enabled,
                enabled && !replaced && module.Info is not null,
                replaced,
                module.Info,
                module.Problem?.ToString()));
        }

        foreach (StoredModule<TInfo> module in shelf.Uploaded.Values)
        {
            bool enabled = !shelf.Disabled.Contains(module.Key);
            entries.Add(new ModuleListingEntry<TInfo>(
                module.Key,
                module.FileName,
                UploadedSource,
                enabled,
                enabled && module.Info is not null,
                false,
                module.Info,
                module.Problem?.ToString()));
        }

        return entries;
    }

    private static List<TInfo> ListOffered<TInfo>(ModuleShelf<TInfo> shelf)
        where TInfo : class
    {
        List<TInfo> offered = [];
        foreach (ModuleListingEntry<TInfo> entry in ListEntries(shelf))
        {
            if (entry.Offered && entry.Info is not null)
            {
                offered.Add(entry.Info);
            }
        }

        return offered;
    }

    /// <summary>
    /// Returns the version of a key clients get: its upload, else its bundled file, when the key is enabled and the file reads.
    /// </summary>
    private static StoredModule<TInfo>? FindOffered<TInfo>(ModuleShelf<TInfo> shelf, string key)
        where TInfo : class
    {
        if (shelf.Disabled.Contains(key))
        {
            return null;
        }

        StoredModule<TInfo>? module = shelf.Uploaded.TryGetValue(key, out StoredModule<TInfo>? uploaded)
            ? uploaded
            : FindBundled(shelf, key);
        return module?.Info is null ? null : module;
    }

    private static StoredModule<TInfo>? FindBundled<TInfo>(ModuleShelf<TInfo> shelf, string key)
        where TInfo : class
    {
        return shelf.Bundled.Find(module => shelf.Comparer.Equals(module.Key, key));
    }

    private void AddBundled<TInfo>(ModuleShelf<TInfo> shelf, string key, string fileName, byte[] bytes, TInfo? info, ModuleProblem? problem)
        where TInfo : class
    {
        // A second bundled file of a key keeps its own file name as its key, so the listing names it apart
        if (FindBundled(shelf, key) is not null)
        {
            problem = new ModuleProblem(KeyDuplicateCode, key);
            info = null;
            key = fileName;
        }

        if (problem is not null)
        {
            logger.LogWarning("WebGPU Player bundled module {FileName} does not read: {Problem}", fileName, problem.ToString());
        }

        shelf.Bundled.Add(new StoredModule<TInfo>(key, fileName, bytes, info, problem));
    }

    private (DecoderPackageInfo? Package, ModuleProblem? Problem) ReadDecoderPackage(byte[] bytes)
    {
        return decoderPackageSection is null
            ? (null, new ModuleProblem(SectionUnknownCode, "the add-on manifest names no decoder package section"))
            : DecoderPackageFunctions.ReadPackage(bytes, decoderPackageSection);
    }

    private void LoadUploadedDecoderPackages()
    {
        foreach ((string fileName, byte[] bytes) in ReadUploadedFiles(decoderPackages.FolderPath, DecoderPackageFunctions.FileExtension))
        {
            // The store names each upload by its id, so a file of another name was not written here
            string fileId = Path.GetFileNameWithoutExtension(fileName);
            (DecoderPackageInfo? package, ModuleProblem? problem) = ReadDecoderPackage(bytes);
            if (package is not null && !string.Equals(package.Id, fileId, StringComparison.Ordinal))
            {
                problem = new ModuleProblem(IdMismatchCode, "'" + package.Id + "' in " + fileName);
                package = null;
            }

            if (problem is not null)
            {
                logger.LogWarning("WebGPU Player uploaded decoder package {FileName} does not read: {Problem}", fileName, problem.ToString());
            }

            decoderPackages.Uploaded[fileId] = new StoredModule<DecoderPackageInfo>(fileId, fileName, bytes, package, problem);
        }
    }

    private void LoadUploadedPasses()
    {
        foreach ((string fileName, byte[] bytes) in ReadUploadedFiles(passes.FolderPath, PassFileFunctions.FileExtension))
        {
            (PassFileInfo? file, ModuleProblem? problem) = PassFileFunctions.ReadPassFile(fileName, bytes);
            if (problem is not null)
            {
                logger.LogWarning("WebGPU Player uploaded pass file {FileName} does not read: {Problem}", fileName, problem.ToString());
            }

            passes.Uploaded[fileName] = new StoredModule<PassFileInfo>(fileName, fileName, bytes, file, problem);
        }
    }

    private List<(string FileName, byte[] Bytes)> ReadUploadedFiles(string directory, string extension)
    {
        List<(string FileName, byte[] Bytes)> files = [];
        if (!Directory.Exists(directory))
        {
            return files;
        }

        foreach (string path in Directory.EnumerateFiles(directory))
        {
            // An interrupted write leaves a temporary file, which is not an upload
            if (!string.Equals(Path.GetExtension(path), extension, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            try
            {
                files.Add((Path.GetFileName(path), File.ReadAllBytes(path)));
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                logger.LogWarning(exception, "WebGPU Player could not read uploaded module {Path}", path);
            }
        }

        return files;
    }

    private void LoadState()
    {
        if (!File.Exists(stateFilePath))
        {
            return;
        }

        ModuleState? state;
        try
        {
            state = JsonSerializer.Deserialize<ModuleState>(File.ReadAllBytes(stateFilePath), StateJsonOptions);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            logger.LogWarning(exception, "WebGPU Player could not read {Path}; every module is enabled", stateFilePath);
            return;
        }

        if (state?.Version != StateVersion)
        {
            logger.LogWarning("WebGPU Player state {Path} is of another version; every module is enabled", stateFilePath);
            return;
        }

        decoderPackages.Disabled.UnionWith(state.DisabledDecoderPackages ?? []);
        passes.Disabled.UnionWith(state.DisabledPasses ?? []);
    }

    private ModuleProblem? SaveState()
    {
        ModuleState state = new ModuleState(StateVersion, Sorted(decoderPackages.Disabled), Sorted(passes.Disabled));
        return WriteFile(stateFilePath, JsonSerializer.SerializeToUtf8Bytes(state, StateJsonOptions));
    }

    private ModuleProblem? AddUpload<TInfo>(ModuleShelf<TInfo> shelf, string key, string fileName, byte[] bytes, TInfo info)
        where TInfo : class
    {
        // A pass file name that differs only in case names another file on a case-sensitive file system, so the replaced upload's file goes first
        if (shelf.Uploaded.TryGetValue(key, out StoredModule<TInfo>? replaced) && !string.Equals(replaced.FileName, fileName, StringComparison.Ordinal))
        {
            ModuleProblem? deleteProblem = DeleteFile(Path.Combine(shelf.FolderPath, replaced.FileName));
            if (deleteProblem is not null)
            {
                return deleteProblem;
            }

            shelf.Uploaded.Remove(key);
        }

        ModuleProblem? writeProblem = WriteFile(Path.Combine(shelf.FolderPath, fileName), bytes);
        if (writeProblem is not null)
        {
            return writeProblem;
        }

        // Removed first, so the key keeps the new file's casing
        shelf.Uploaded.Remove(key);
        shelf.Uploaded[key] = new StoredModule<TInfo>(key, fileName, bytes, info, null);
        return null;
    }

    private ModuleProblem? RemoveUpload<TInfo>(ModuleShelf<TInfo> shelf, string key)
        where TInfo : class
    {
        if (!shelf.Uploaded.TryGetValue(key, out StoredModule<TInfo>? module))
        {
            return new ModuleProblem(ModuleProblem.UnknownModuleCode, "'" + key + "'");
        }

        ModuleProblem? deleteProblem = DeleteFile(Path.Combine(shelf.FolderPath, module.FileName));
        if (deleteProblem is not null)
        {
            return deleteProblem;
        }

        shelf.Uploaded.Remove(key);

        // A key no file holds any more keeps no state
        return FindBundled(shelf, key) is null && shelf.Disabled.Remove(key) ? SaveState() : null;
    }

    private ModuleProblem? SetEnabled<TInfo>(ModuleShelf<TInfo> shelf, string key, bool enabled)
        where TInfo : class
    {
        if (!shelf.Uploaded.ContainsKey(key) && FindBundled(shelf, key) is null)
        {
            return new ModuleProblem(ModuleProblem.UnknownModuleCode, "'" + key + "'");
        }

        bool changed = enabled ? shelf.Disabled.Remove(key) : shelf.Disabled.Add(key);
        if (!changed)
        {
            return null;
        }

        ModuleProblem? saveProblem = SaveState();
        if (saveProblem is not null)
        {
            // The state stays as stored
            if (enabled)
            {
                shelf.Disabled.Add(key);
            }
            else
            {
                shelf.Disabled.Remove(key);
            }
        }

        return saveProblem;
    }

    /// <summary>
    /// Writes a file through a temporary sibling, so a reader or a restart never sees part of it.
    /// </summary>
    private ModuleProblem? WriteFile(string path, byte[] bytes)
    {
        string temporaryPath = path + TemporaryFileExtension;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllBytes(temporaryPath, bytes);
            File.Move(temporaryPath, path, overwrite: true);
            return null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            logger.LogWarning(exception, "WebGPU Player could not write {Path}", path);
            return new ModuleProblem(ModuleProblem.WriteFailedCode, exception.Message);
        }
    }

    private ModuleProblem? DeleteFile(string path)
    {
        try
        {
            File.Delete(path);
            return null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            logger.LogWarning(exception, "WebGPU Player could not delete {Path}", path);
            return new ModuleProblem(ModuleProblem.WriteFailedCode, exception.Message);
        }
    }

    private static List<string> Sorted(HashSet<string> keys)
    {
        List<string> sorted = [.. keys];
        sorted.Sort(StringComparer.Ordinal);
        return sorted;
    }

    /// <summary>
    /// One module file the store holds: its key, its file name, its bytes, and what it declares or why it does not read.
    /// </summary>
    private sealed record StoredModule<TInfo>(string Key, string FileName, byte[] Bytes, TInfo? Info, ModuleProblem? Problem)
        where TInfo : class;

    /// <summary>
    /// The files of one module kind: the bundled ones in order, the uploads by key, and the disabled keys, all keyed with one comparer.
    /// </summary>
    private sealed class ModuleShelf<TInfo>(string folderPath, StringComparer comparer)
        where TInfo : class
    {
        public string FolderPath { get; } = folderPath;

        public StringComparer Comparer { get; } = comparer;

        public List<StoredModule<TInfo>> Bundled { get; } = [];

        public SortedDictionary<string, StoredModule<TInfo>> Uploaded { get; } = new SortedDictionary<string, StoredModule<TInfo>>(comparer);

        public HashSet<string> Disabled { get; } = new HashSet<string>(comparer);
    }
}
