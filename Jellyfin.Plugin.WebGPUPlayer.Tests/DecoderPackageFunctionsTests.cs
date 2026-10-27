using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using Jellyfin.Plugin.WebGPUPlayer.Addon;
using Jellyfin.Plugin.WebGPUPlayer.Modules;
using Xunit;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

public sealed class DecoderPackageFunctionsTests
{
    private const string OtherSection = "webgpu-player.vectors";
    private const string NotAModule = "not a module";
    // A UTF-8 lead byte without its continuation byte
    private static readonly byte[] InvalidUTF8 = [0xC3, 0x28];
    // The video header's directive lines, which end at the blank line before its body
    private static readonly string VideoHeaderLines = ModuleTestFiles.VideoHeader[..ModuleTestFiles.VideoHeader.IndexOf("\n\n", StringComparison.Ordinal)];

    // Every package the add-on build carries, which the plugin offers as bundled
    public static TheoryData<string> BundledPackages
    {
        get
        {
            TheoryData<string> packages = new TheoryData<string>();
            foreach (string path in AddonCatalog.Modules.DecoderPackagePaths)
            {
                packages.Add(path);
            }

            return packages;
        }
    }

    [Fact]
    public void ReadPackage_VideoPackage_ReadsWhatItsHeaderDeclares()
    {
        byte[] bytes = ModuleTestFiles.CreatePackage(ModuleTestFiles.VideoHeader);

        (DecoderPackageInfo? package, ModuleProblem? problem) = DecoderPackageFunctions.ReadPackage(bytes, ModuleTestFiles.DecoderSection);

        Assert.Null(problem);
        Assert.NotNull(package);
        Assert.Equal(ModuleTestFiles.HEVCId, package.Id);
        Assert.Equal(ModuleTestFiles.HEVCName, package.Name);
        Assert.Equal(DecoderPackageFunctions.VideoKind, package.Kind);
        Assert.Equal(["hevc"], package.Codecs);
        Assert.Equal(["I420", "I420P10"], package.OutputFormats);
        Assert.True(package.Monochrome);
        Assert.Equal(VideoHeaderLines, package.Header);
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(bytes)), package.ContentHash);
        Assert.Equal(bytes.Length, package.ByteLength);
    }

    [Fact]
    public void ReadPackage_AudioPackage_ReadsItsCodecsAndNoFormats()
    {
        byte[] bytes = ModuleTestFiles.CreatePackage(ModuleTestFiles.AudioHeader);

        (DecoderPackageInfo? package, ModuleProblem? problem) = DecoderPackageFunctions.ReadPackage(bytes, ModuleTestFiles.DecoderSection);

        Assert.Null(problem);
        Assert.NotNull(package);
        Assert.Equal(ModuleTestFiles.EAC3Id, package.Id);
        Assert.Equal(DecoderPackageFunctions.AudioKind, package.Kind);
        Assert.Equal(["eac3", "ac3"], package.Codecs);
        Assert.Empty(package.OutputFormats);
        Assert.False(package.Monochrome);
        Assert.Null(package.Header);
    }

    [Fact]
    public void ReadPackage_CRLFHeader_KeepsItsLinesWithoutCarriageReturns()
    {
        byte[] bytes = ModuleTestFiles.CreatePackage(ModuleTestFiles.VideoHeader.Replace("\n", "\r\n", StringComparison.Ordinal));

        DecoderPackageInfo? package = DecoderPackageFunctions.ReadPackage(bytes, ModuleTestFiles.DecoderSection).Package;

        Assert.NotNull(package);
        Assert.Equal(VideoHeaderLines, package.Header);
    }

    [Fact]
    public void ReadPackage_SectionAfterOtherCustomSections_IsFound()
    {
        byte[] bytes = ModuleTestFiles.CreateModule(
            (OtherSection, [1, 2, 3]),
            (ModuleTestFiles.DecoderSection, Encoding.UTF8.GetBytes(ModuleTestFiles.AudioHeader)));

        (DecoderPackageInfo? package, ModuleProblem? problem) = DecoderPackageFunctions.ReadPackage(bytes, ModuleTestFiles.DecoderSection);

        Assert.Null(problem);
        Assert.Equal(ModuleTestFiles.EAC3Id, package?.Id);
    }

    [Fact]
    public void ReadPackage_UnreadableFiles_ReportTheFailedCheck()
    {
        byte[] withoutSection = ModuleTestFiles.CreateModule((OtherSection, [1]));
        byte[] repeatedSection = ModuleTestFiles.CreateModule(
            (ModuleTestFiles.DecoderSection, Encoding.UTF8.GetBytes(ModuleTestFiles.AudioHeader)),
            (ModuleTestFiles.DecoderSection, Encoding.UTF8.GetBytes(ModuleTestFiles.AudioHeader)));
        byte[] truncated = ModuleTestFiles.CreatePackage(ModuleTestFiles.AudioHeader)[..^4];

        Assert.Equal("package-invalid", ReadProblem(Encoding.UTF8.GetBytes(NotAModule))?.Code);
        Assert.Equal("package-invalid", ReadProblem(truncated)?.Code);
        Assert.Equal(new ModuleProblem("package-section-missing", ModuleTestFiles.DecoderSection), ReadProblem(withoutSection));
        Assert.Equal(new ModuleProblem("package-section-repeated", ModuleTestFiles.DecoderSection + " 2 times"), ReadProblem(repeatedSection));
        Assert.Equal("package-encoding", ReadProblem(ModuleTestFiles.CreateModule((ModuleTestFiles.DecoderSection, InvalidUTF8)))?.Code);
    }

    [Theory]
    [InlineData("id", "", "directive-missing: 'id' (line 1)")]
    [InlineData("id", "//! id: HEVC", "id-syntax: 'HEVC' (line 1)")]
    [InlineData("id", "//! id: a-very-long-id-that-runs-past-the-sixty-four-characters-a-package-id-may-have", "id-length: 77 > 64 (line 1)")]
    [InlineData("name", "//! name:", "name-syntax: '' (line 2)")]
    [InlineData("decoder", "//! decoder: subtitle", "decoder-kind: 'subtitle' (line 3)")]
    [InlineData("accepts", "//! accepts: hevc", "accepts-syntax: 'hevc' (line 4)")]
    [InlineData("accepts", "//! accepts: codec in [hevc, Hevc]", "codec-syntax: 'Hevc' (line 4)")]
    [InlineData("accepts", "//! accepts: codec in [hevc, hevc]", "codec-duplicate: 'hevc' (line 4)")]
    [InlineData("output", "", "directive-missing: 'output' (line 1)")]
    [InlineData("output", "//! output: I420, I420-P10", "output-syntax: 'I420-P10' (line 5)")]
    [InlineData("monochrome", "//! monochrome: no", "monochrome-syntax: 'no' (line 6)")]
    [InlineData("packet", "//! packet 1 MiB", "header-syntax: '//! packet 1 MiB' (line 7)")]
    public void ReadPackage_MalformedHeader_ReportsTheManifestCheck(string directive, string replacement, string expectedDetail)
    {
        byte[] bytes = ModuleTestFiles.CreatePackage(ModuleTestFiles.ReplaceVideoHeaderLine(directive, replacement));

        Assert.Equal(new ModuleProblem("package-manifest", expectedDetail), ReadProblem(bytes));
    }

    [Fact]
    public void ReadPackage_AudioConditions_AreRefused()
    {
        byte[] bytes = ModuleTestFiles.CreatePackage(ModuleTestFiles.AudioHeader.Replace("[eac3, ac3]", "[eac3], stream.width <= 1", StringComparison.Ordinal));

        Assert.Equal(new ModuleProblem("package-manifest", "accepts-syntax: 'codec in [eac3], stream.width <= 1' (line 4)"), ReadProblem(bytes));
    }

    [Fact]
    public void ReadPackage_WithoutHeader_ReportsTheFirstLine()
    {
        byte[] bytes = ModuleTestFiles.CreatePackage("fn main() {}\n");

        Assert.Equal(new ModuleProblem("package-manifest", "header-missing: 'fn main() {}' (line 1)"), ReadProblem(bytes));
    }

    [Theory]
    [MemberData(nameof(BundledPackages))]
    public void ReadPackage_BundledPackage_Reads(string path)
    {
        using Stream stream = AddonCatalog.OpenAsset(path)!;
        using MemoryStream copy = new MemoryStream();
        stream.CopyTo(copy);

        (DecoderPackageInfo? package, ModuleProblem? problem) = DecoderPackageFunctions.ReadPackage(copy.ToArray(), AddonCatalog.Modules.DecoderPackageSection!);

        Assert.Null(problem);
        Assert.NotNull(package);
        Assert.Equal(Path.GetFileNameWithoutExtension(path), package.Id);
        Assert.NotEmpty(package.Codecs);
        // A video package's header carries its accepts conditions and sizes, and none of its WGSL body
        if (package.Kind == DecoderPackageFunctions.VideoKind)
        {
            Assert.NotNull(package.Header);
            string[] headerLines = package.Header.Split('\n');
            Assert.All(headerLines, line => Assert.StartsWith("//!", line, StringComparison.Ordinal));
            Assert.Contains(headerLines, line => line.StartsWith("//! accepts: codec in [", StringComparison.Ordinal));
            Assert.Contains(headerLines, line => line.StartsWith("//! packet:", StringComparison.Ordinal));
        }
        else
        {
            Assert.Null(package.Header);
        }
    }

    private static ModuleProblem? ReadProblem(byte[] bytes)
    {
        return DecoderPackageFunctions.ReadPackage(bytes, ModuleTestFiles.DecoderSection).Problem;
    }
}
