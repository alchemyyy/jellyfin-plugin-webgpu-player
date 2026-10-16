using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Jellyfin.Plugin.WebGPUPlayer.Modules;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

public sealed class ModuleStoreTests : IDisposable
{
    private const string BundledHEVCFileName = "hevc.wasm";
    private const string BundledEAC3FileName = "eac3.wasm";
    private const string RebuiltHEVCName = "HEVC rebuilt";
    private const string UppercaseSharpenFileName = "Sharpen.wgsl";
    private const string BlendFileName = "blend.wgsl";
    private const string BlendSource = "//! name: Blend\nfn kernel() {}\n";
    private const string UnknownKey = "vc1";
    private const string StateOfAnotherVersion = "{\"version\":0,\"disabledDecoderPackages\":[\"hevc\"],\"disabledPasses\":[]}";
    private const string StrayUploadFileName = "mpeg2.wasm";

    private readonly DirectoryInfo dataFolder = Directory.CreateTempSubdirectory("webgpu-player-modules-");

    public void Dispose()
    {
        dataFolder.Delete(recursive: true);
    }

    [Fact]
    public void GetCatalog_BundledFiles_AreOfferedInOrder()
    {
        ModuleStore store = CreateStore();

        ModuleCatalog catalog = store.GetCatalog();

        Assert.Equal([ModuleTestFiles.HEVCId, ModuleTestFiles.EAC3Id], catalog.DecoderPackages.Select(package => package.Id));
        Assert.Equal([ModuleTestFiles.SharpenFileName], catalog.Passes.Select(file => file.FileName));
    }

    [Fact]
    public void GetCatalog_UnreadableBundledFile_IsListedWithItsProblemAndNotOffered()
    {
        ModuleStore store = new ModuleStore(
            dataFolder.FullName,
            ModuleTestFiles.DecoderSection,
            [(BundledHEVCFileName, Encoding.UTF8.GetBytes("not a module"))],
            [],
            NullLogger<ModuleStore>.Instance);

        ModuleListingEntry<DecoderPackageInfo> entry = Assert.Single(store.GetListing().DecoderPackages);

        Assert.Empty(store.GetCatalog().DecoderPackages);
        Assert.Equal(ModuleTestFiles.HEVCId, entry.Key);
        Assert.False(entry.Offered);
        Assert.StartsWith("package-invalid: ", entry.Problem, StringComparison.Ordinal);
    }

    [Fact]
    public void GetCatalog_WithoutDecoderSection_OffersNoPackage()
    {
        ModuleStore store = new ModuleStore(
            dataFolder.FullName,
            null,
            [(BundledHEVCFileName, ModuleTestFiles.CreatePackage(ModuleTestFiles.VideoHeader))],
            [],
            NullLogger<ModuleStore>.Instance);

        Assert.Empty(store.GetCatalog().DecoderPackages);
        Assert.StartsWith("package-section-unknown: ", Assert.Single(store.GetListing().DecoderPackages).Problem, StringComparison.Ordinal);
    }

    [Fact]
    public void AddDecoderPackage_OfABundledId_ReplacesItUntilRemoved()
    {
        ModuleStore store = CreateStore();
        byte[] rebuilt = ModuleTestFiles.CreatePackage(ModuleTestFiles.VideoHeader.Replace(ModuleTestFiles.HEVCName, RebuiltHEVCName, StringComparison.Ordinal));

        Assert.Null(store.AddDecoderPackage(rebuilt));
        ModuleListing listing = store.GetListing();

        Assert.Equal(rebuilt, store.GetOfferedDecoderPackage(ModuleTestFiles.HEVCId)?.Bytes);
        Assert.Equal(RebuiltHEVCName, store.GetCatalog().DecoderPackages.Single(package => package.Id == ModuleTestFiles.HEVCId).Name);
        Assert.True(listing.DecoderPackages.Single(entry => entry.Source == ModuleStore.BundledSource && entry.Key == ModuleTestFiles.HEVCId).Replaced);
        Assert.True(File.Exists(Path.Combine(dataFolder.FullName, ModuleStore.DecoderPackageFolderName, BundledHEVCFileName)));

        Assert.Null(store.RemoveDecoderPackage(ModuleTestFiles.HEVCId));

        Assert.Equal(ModuleTestFiles.HEVCName, store.GetCatalog().DecoderPackages.Single(package => package.Id == ModuleTestFiles.HEVCId).Name);
        Assert.False(File.Exists(Path.Combine(dataFolder.FullName, ModuleStore.DecoderPackageFolderName, BundledHEVCFileName)));
    }

    [Fact]
    public void AddDecoderPackage_RefusedFile_StoresNothing()
    {
        ModuleStore store = CreateStore();

        ModuleProblem? problem = store.AddDecoderPackage(ModuleTestFiles.CreatePackage(ModuleTestFiles.ReplaceVideoHeaderLine("id", string.Empty)));

        Assert.Equal("package-manifest", problem?.Code);
        Assert.False(Directory.Exists(Path.Combine(dataFolder.FullName, ModuleStore.DecoderPackageFolderName)));
    }

    [Fact]
    public void Uploads_SurviveANewStore()
    {
        byte[] rebuilt = ModuleTestFiles.CreatePackage(ModuleTestFiles.VideoHeader.Replace(ModuleTestFiles.HEVCName, RebuiltHEVCName, StringComparison.Ordinal));
        ModuleStore store = CreateStore();
        Assert.Null(store.AddDecoderPackage(rebuilt));
        Assert.Null(store.AddPass(BlendFileName, Encoding.UTF8.GetBytes(BlendSource)));

        ModuleStore reopened = CreateStore();

        Assert.Equal(rebuilt, reopened.GetOfferedDecoderPackage(ModuleTestFiles.HEVCId)?.Bytes);
        Assert.Equal([ModuleTestFiles.SharpenFileName, BlendFileName], reopened.GetCatalog().Passes.Select(file => file.FileName));
    }

    [Fact]
    public void SetEnabled_DisabledKeys_AreNotOfferedAndSurviveANewStore()
    {
        ModuleStore store = CreateStore();

        Assert.Null(store.SetDecoderPackageEnabled(ModuleTestFiles.HEVCId, false));
        Assert.Null(store.SetPassEnabled(ModuleTestFiles.SharpenFileName, false));
        ModuleStore reopened = CreateStore();

        Assert.Null(reopened.GetOfferedDecoderPackage(ModuleTestFiles.HEVCId));
        Assert.Null(reopened.GetOfferedPass(ModuleTestFiles.SharpenFileName));
        Assert.Equal([ModuleTestFiles.EAC3Id], reopened.GetCatalog().DecoderPackages.Select(package => package.Id));
        Assert.False(reopened.GetListing().DecoderPackages.Single(entry => entry.Key == ModuleTestFiles.HEVCId).Enabled);

        Assert.Null(reopened.SetDecoderPackageEnabled(ModuleTestFiles.HEVCId, true));

        Assert.NotNull(reopened.GetOfferedDecoderPackage(ModuleTestFiles.HEVCId));
    }

    [Fact]
    public void SetEnabled_AppliesToTheUploadThatReplacesABundledFile()
    {
        ModuleStore store = CreateStore();
        Assert.Null(store.SetDecoderPackageEnabled(ModuleTestFiles.HEVCId, false));

        Assert.Null(store.AddDecoderPackage(ModuleTestFiles.CreatePackage(ModuleTestFiles.VideoHeader.Replace(ModuleTestFiles.HEVCName, RebuiltHEVCName, StringComparison.Ordinal))));

        Assert.Null(store.GetOfferedDecoderPackage(ModuleTestFiles.HEVCId));
    }

    [Fact]
    public void Changes_OfUnknownKeys_AreRefused()
    {
        ModuleStore store = CreateStore();

        Assert.Equal(ModuleProblem.UnknownModuleCode, store.SetDecoderPackageEnabled(UnknownKey, false)?.Code);
        Assert.Equal(ModuleProblem.UnknownModuleCode, store.SetPassEnabled(BlendFileName, false)?.Code);
        Assert.Equal(ModuleProblem.UnknownModuleCode, store.RemoveDecoderPackage(ModuleTestFiles.HEVCId)?.Code);
        Assert.Equal(ModuleProblem.UnknownModuleCode, store.RemovePass(ModuleTestFiles.SharpenFileName)?.Code);
    }

    [Fact]
    public void AddPass_NameDifferingInCase_ReplacesTheBundledFileAndAnEarlierUpload()
    {
        ModuleStore store = CreateStore();
        string passFolder = Path.Combine(dataFolder.FullName, ModuleStore.PassFolderName);
        Assert.Null(store.AddPass(ModuleTestFiles.SharpenFileName, Encoding.UTF8.GetBytes(ModuleTestFiles.SharpenSource)));

        Assert.Null(store.AddPass(UppercaseSharpenFileName, Encoding.UTF8.GetBytes(ModuleTestFiles.SharpenSource)));

        Assert.Equal([UppercaseSharpenFileName], Directory.GetFiles(passFolder).Select(Path.GetFileName));
        Assert.Equal([UppercaseSharpenFileName], store.GetCatalog().Passes.Select(file => file.FileName));
        Assert.NotNull(store.GetOfferedPass(ModuleTestFiles.SharpenFileName));
    }

    [Fact]
    public void RemoveUpload_OfAKeyNoBundledFileHas_DropsItsState()
    {
        ModuleStore store = CreateStore();
        Assert.Null(store.AddPass(BlendFileName, Encoding.UTF8.GetBytes(BlendSource)));
        Assert.Null(store.SetPassEnabled(BlendFileName, false));

        Assert.Null(store.RemovePass(BlendFileName));
        Assert.Null(store.AddPass(BlendFileName, Encoding.UTF8.GetBytes(BlendSource)));

        Assert.NotNull(store.GetOfferedPass(BlendFileName));
    }

    [Fact]
    public void LoadState_OfAnotherVersion_EnablesEveryModule()
    {
        File.WriteAllText(Path.Combine(dataFolder.FullName, ModuleStore.StateFileName), StateOfAnotherVersion);

        ModuleStore store = CreateStore();

        Assert.NotNull(store.GetOfferedDecoderPackage(ModuleTestFiles.HEVCId));
    }

    [Fact]
    public void LoadUploads_FileNamedForAnotherId_IsListedWithItsProblem()
    {
        string packageFolder = Path.Combine(dataFolder.FullName, ModuleStore.DecoderPackageFolderName);
        Directory.CreateDirectory(packageFolder);
        File.WriteAllBytes(Path.Combine(packageFolder, StrayUploadFileName), ModuleTestFiles.CreatePackage(ModuleTestFiles.VideoHeader));

        ModuleStore store = CreateStore();
        ModuleListingEntry<DecoderPackageInfo> stray = store.GetListing().DecoderPackages.Single(entry => entry.Source == ModuleStore.UploadedSource);

        Assert.Equal("package-id-mismatch: 'hevc' in mpeg2.wasm", stray.Problem);
        Assert.False(stray.Offered);
        Assert.Null(store.RemoveDecoderPackage(stray.Key));
        Assert.False(File.Exists(Path.Combine(packageFolder, StrayUploadFileName)));
    }

    private ModuleStore CreateStore()
    {
        List<(string FileName, byte[] Bytes)> bundledPackages =
        [
            (BundledHEVCFileName, ModuleTestFiles.CreatePackage(ModuleTestFiles.VideoHeader)),
            (BundledEAC3FileName, ModuleTestFiles.CreatePackage(ModuleTestFiles.AudioHeader))
        ];
        List<(string FileName, byte[] Bytes)> bundledPasses = [(ModuleTestFiles.SharpenFileName, Encoding.UTF8.GetBytes(ModuleTestFiles.SharpenSource))];
        return new ModuleStore(dataFolder.FullName, ModuleTestFiles.DecoderSection, bundledPackages, bundledPasses, NullLogger<ModuleStore>.Instance);
    }
}
