using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using Jellyfin.Plugin.WebGPUPlayer.Addon;
using Jellyfin.Plugin.WebGPUPlayer.Modules;
using Xunit;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

public sealed class PassFileFunctionsTests
{
    private const string ChainFileName = "Anime4K_Chain-2.x.wgsl";
    private const string FirstPassName = "Chain 1/2";
    private const string SecondPassName = "Chain 2/2";
    // One file of two passes, each with its own header, the second indented as some editors leave it
    private const string ChainSource =
        "//! name: Chain 1/2\n"
        + "//! shape: compute\n"
        + "fn first() {}\n"
        + "  //! name:   Chain 2/2  \r\n"
        + "//! shape: compute\n"
        + "fn second() {}\n";

    private const string ByteOrderMark = "﻿";
    private const string NullCharacterSource = "//! name: Sharpen\n\0";
    private const string HeaderlessSource = "fn kernel() {}\n";
    private const string BlankSource = " \n\t\n";
    // A UTF-8 lead byte without its continuation byte
    private static readonly byte[] InvalidUTF8 = [0xC3, 0x28];

    // Every pass file the add-on build carries, which the plugin offers as bundled
    public static TheoryData<string> BundledPasses
    {
        get
        {
            TheoryData<string> passes = new TheoryData<string>();
            foreach (string path in AddonCatalog.Modules.PassPaths)
            {
                passes.Add(path);
            }

            return passes;
        }
    }

    [Theory]
    [InlineData("sharpen.wgsl")]
    [InlineData("Anime4K_Upscale_Denoise_CNN_x2_UL.wgsl")]
    [InlineData("temporal-blend.v2.WGSL")]
    public void FindFileNameProblem_UsableName_IsNull(string fileName)
    {
        Assert.Null(PassFileFunctions.FindFileNameProblem(fileName));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("sharpen.glsl")]
    [InlineData(".wgsl")]
    [InlineData("../sharpen.wgsl")]
    [InlineData("passes/sharpen.wgsl")]
    [InlineData("passes\\sharpen.wgsl")]
    [InlineData("sharp en.wgsl")]
    [InlineData("-sharpen.wgsl")]
    public void FindFileNameProblem_UnsafeOrForeignName_IsRefused(string? fileName)
    {
        Assert.Equal("pass-file-name", PassFileFunctions.FindFileNameProblem(fileName)?.Code);
    }

    [Fact]
    public void FindFileNameProblem_LongName_IsRefusedWithItsLength()
    {
        string fileName = new string('a', 130) + PassFileFunctions.FileExtension;

        Assert.Equal(new ModuleProblem("pass-file-name", "135 > 128"), PassFileFunctions.FindFileNameProblem(fileName));
    }

    [Fact]
    public void ReadPassFile_SeveralPasses_ReadsEachNameInFileOrder()
    {
        byte[] bytes = Encoding.UTF8.GetBytes(ChainSource);

        (PassFileInfo? file, ModuleProblem? problem) = PassFileFunctions.ReadPassFile(ChainFileName, bytes);

        Assert.Null(problem);
        Assert.NotNull(file);
        Assert.Equal(ChainFileName, file.FileName);
        Assert.Equal([FirstPassName, SecondPassName], file.PassNames);
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(bytes)), file.ContentHash);
        Assert.Equal(bytes.Length, file.ByteLength);
    }

    [Fact]
    public void ReadPassFile_ByteOrderMark_IsSkipped()
    {
        (PassFileInfo? file, ModuleProblem? problem) = PassFileFunctions.ReadPassFile(
            ModuleTestFiles.SharpenFileName,
            Encoding.UTF8.GetBytes(ByteOrderMark + ModuleTestFiles.SharpenSource));

        Assert.Null(problem);
        Assert.Equal([ModuleTestFiles.SharpenPassName], file?.PassNames);
    }

    [Fact]
    public void ReadPassFile_UnusableSources_ReportTheFailedCheck()
    {
        Assert.Equal("pass-encoding", ReadProblem(InvalidUTF8)?.Code);
        Assert.Equal("pass-empty", ReadProblem(Encoding.UTF8.GetBytes(BlankSource))?.Code);
        Assert.Equal(new ModuleProblem("pass-null-character", "at 18"), ReadProblem(Encoding.UTF8.GetBytes(NullCharacterSource)));
        Assert.Equal("pass-header-missing", ReadProblem(Encoding.UTF8.GetBytes(HeaderlessSource))?.Code);
        Assert.Equal("pass-file-name", PassFileFunctions.ReadPassFile("sharpen.txt", Encoding.UTF8.GetBytes(ModuleTestFiles.SharpenSource)).Problem?.Code);
    }

    [Theory]
    [MemberData(nameof(BundledPasses))]
    public void ReadPassFile_BundledPass_Reads(string path)
    {
        using Stream stream = AddonCatalog.OpenAsset(path)!;
        using MemoryStream copy = new MemoryStream();
        stream.CopyTo(copy);

        (PassFileInfo? file, ModuleProblem? problem) = PassFileFunctions.ReadPassFile(Path.GetFileName(path), copy.ToArray());

        Assert.Null(problem);
        Assert.NotNull(file);
        Assert.NotEmpty(file.PassNames);
    }

    private static ModuleProblem? ReadProblem(byte[] bytes)
    {
        return PassFileFunctions.ReadPassFile(ModuleTestFiles.SharpenFileName, bytes).Problem;
    }
}
