using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

public sealed class PlaybackInfoDecompressionMiddlewareTests
{
    private const string PlaybackInfoJson = "{\"DeviceProfile\":{\"Name\":\"webgpu\"},\"IsPlayback\":true}";

    [Theory]
    [InlineData("/Items/item/PlaybackInfo")]
    [InlineData("/jellyfin/items/0123abcd/playbackinfo")]
    public async Task GzipPlaybackInfo_ReachesNextAsTheOriginalJSON(string path)
    {
        byte[] json = Encoding.UTF8.GetBytes(PlaybackInfoJson);
        DefaultHttpContext context = CreateContext("POST", path, Gzip(json), "gzip");
        ReceivedRequest received = new ReceivedRequest();

        await new PlaybackInfoDecompressionMiddleware(received.Next).InvokeAsync(context);

        Assert.True(received.Called);
        Assert.Equal(json, received.Body);
        Assert.Equal(json.Length, received.ContentLength);
        Assert.False(received.HasContentEncoding);
    }

    [Theory]
    [InlineData("POST", "/Items/item/PlaybackInfo", null)]
    [InlineData("POST", "/Items/item/PlaybackInfo", "br")]
    [InlineData("POST", "/Items/item/PlaybackInfo", "gzip, gzip")]
    [InlineData("POST", "/Sessions/Playing", "gzip")]
    [InlineData("POST", "/Items/PlaybackInfo", "gzip")]
    [InlineData("GET", "/Items/item/PlaybackInfo", "gzip")]
    public async Task OtherRequests_ReachNextUnchanged(string method, string path, string? contentEncoding)
    {
        byte[] body = Encoding.UTF8.GetBytes(PlaybackInfoJson);
        DefaultHttpContext context = CreateContext(method, path, body, contentEncoding);
        ReceivedRequest received = new ReceivedRequest();

        await new PlaybackInfoDecompressionMiddleware(received.Next).InvokeAsync(context);

        Assert.True(received.Called);
        Assert.Equal(body, received.Body);
        Assert.Equal(body.Length, received.ContentLength);
        Assert.Equal(contentEncoding is not null, received.HasContentEncoding);
    }

    [Fact]
    public async Task BodyPastTheDecompressedLimit_Gets413WithoutCallingNext()
    {
        byte[] oversized = new byte[PlaybackInfoDecompressionMiddleware.MaximumDecompressedByteLength + 1];
        DefaultHttpContext context = CreateContext("POST", "/Items/item/PlaybackInfo", Gzip(oversized), "gzip");
        ReceivedRequest received = new ReceivedRequest();

        await new PlaybackInfoDecompressionMiddleware(received.Next).InvokeAsync(context);

        Assert.False(received.Called);
        Assert.Equal(StatusCodes.Status413PayloadTooLarge, context.Response.StatusCode);
    }

    [Fact]
    public async Task CorruptGzip_Gets400WithoutCallingNext()
    {
        byte[] corrupt = Gzip(Encoding.UTF8.GetBytes(PlaybackInfoJson));
        corrupt[3] = 0xFF;
        corrupt[10] ^= 0xFF;
        DefaultHttpContext context = CreateContext("POST", "/Items/item/PlaybackInfo", corrupt, "gzip");
        ReceivedRequest received = new ReceivedRequest();

        await new PlaybackInfoDecompressionMiddleware(received.Next).InvokeAsync(context);

        Assert.False(received.Called);
        Assert.Equal(StatusCodes.Status400BadRequest, context.Response.StatusCode);
    }

    [Fact]
    public async Task SignedInGzipPlaybackInfo_IsDecompressed()
    {
        byte[] json = Encoding.UTF8.GetBytes(PlaybackInfoJson);
        DefaultHttpContext context = CreateContext("POST", "/Items/item/PlaybackInfo", Gzip(json), "gzip");
        FakeAuthorizationContext authorization = UseAuthorization(context, isAuthenticated: true);
        ReceivedRequest received = new ReceivedRequest();

        await new PlaybackInfoDecompressionMiddleware(received.Next).InvokeAsync(context);

        Assert.Equal(1, authorization.CallCount);
        Assert.True(received.Called);
        Assert.Equal(json, received.Body);
        Assert.False(received.HasContentEncoding);
    }

    [Fact]
    public async Task UnauthenticatedGzipPlaybackInfo_ReachesNextStillCompressed()
    {
        // A body that inflates past the limit: decompressing it would answer 413, so reaching next shows it was not read
        byte[] compressed = Gzip(new byte[PlaybackInfoDecompressionMiddleware.MaximumDecompressedByteLength + 1]);
        DefaultHttpContext context = CreateContext("POST", "/Items/item/PlaybackInfo", compressed, "gzip");
        UseAuthorization(context, isAuthenticated: false);
        ReceivedRequest received = new ReceivedRequest();

        await new PlaybackInfoDecompressionMiddleware(received.Next).InvokeAsync(context);

        Assert.True(received.Called);
        Assert.Equal(compressed, received.Body);
        Assert.Equal(compressed.Length, received.ContentLength);
        Assert.True(received.HasContentEncoding);
    }

    [Fact]
    public async Task DisabledUsersGzipPlaybackInfo_ReachesNextStillCompressed()
    {
        byte[] compressed = Gzip(Encoding.UTF8.GetBytes(PlaybackInfoJson));
        DefaultHttpContext context = CreateContext("POST", "/Items/item/PlaybackInfo", compressed, "gzip");
        User user = new User("locked-out", "auth-provider", "reset-provider");
        user.SetPermission(PermissionKind.IsDisabled, true);
        UseAuthorization(context, isAuthenticated: true, user);
        ReceivedRequest received = new ReceivedRequest();

        await new PlaybackInfoDecompressionMiddleware(received.Next).InvokeAsync(context);

        Assert.True(received.Called);
        Assert.Equal(compressed, received.Body);
        Assert.True(received.HasContentEncoding);
    }

    [Fact]
    public async Task OtherRequests_DoNotAuthenticate()
    {
        DefaultHttpContext context = CreateContext("POST", "/Sessions/Playing", Encoding.UTF8.GetBytes(PlaybackInfoJson), null);
        FakeAuthorizationContext authorization = UseAuthorization(context, isAuthenticated: true);
        ReceivedRequest received = new ReceivedRequest();

        await new PlaybackInfoDecompressionMiddleware(received.Next).InvokeAsync(context);

        Assert.True(received.Called);
        Assert.Equal(0, authorization.CallCount);
    }

    [Fact]
    public void RegisterServices_AddsTheDecompressionMiddleware()
    {
        ServiceCollection services = new ServiceCollection();

        new PluginServiceRegistrator().RegisterServices(services, null!);

        Assert.Contains(services, descriptor => descriptor.ServiceType == typeof(IStartupFilter) && descriptor.ImplementationType == typeof(PlaybackInfoDecompressionStartupFilter));
    }

    private static DefaultHttpContext CreateContext(string method, string path, byte[] body, string? contentEncoding)
    {
        DefaultHttpContext context = new DefaultHttpContext();
        context.Request.Method = method;
        context.Request.Path = path;
        context.Request.Body = new MemoryStream(body);
        context.Request.ContentLength = body.Length;
        context.Request.ContentType = "application/json";
        if (contentEncoding is not null)
        {
            context.Request.Headers.ContentEncoding = contentEncoding;
        }

        return context;
    }

    private static FakeAuthorizationContext UseAuthorization(DefaultHttpContext context, bool isAuthenticated, User? user = null)
    {
        FakeAuthorizationContext authorization = new FakeAuthorizationContext(isAuthenticated, user);
        context.RequestServices = new ServiceCollection()
            .AddSingleton<IAuthorizationContext>(authorization)
            .BuildServiceProvider();
        return authorization;
    }

    private static byte[] Gzip(byte[] content)
    {
        using MemoryStream compressed = new MemoryStream();
        using (GZipStream gzip = new GZipStream(compressed, CompressionLevel.Optimal, leaveOpen: true))
        {
            gzip.Write(content);
        }

        return compressed.ToArray();
    }

    private sealed class ReceivedRequest
    {
        public bool Called { get; private set; }

        public byte[]? Body { get; private set; }

        public long? ContentLength { get; private set; }

        public bool HasContentEncoding { get; private set; }

        public async Task Next(HttpContext context)
        {
            Called = true;
            using MemoryStream body = new MemoryStream();
            await context.Request.Body.CopyToAsync(body, context.RequestAborted);
            Body = body.ToArray();
            ContentLength = context.Request.ContentLength;
            HasContentEncoding = context.Request.Headers.ContainsKey("Content-Encoding");
        }
    }

    private sealed class FakeAuthorizationContext(bool isAuthenticated, User? user) : IAuthorizationContext
    {
        public int CallCount { get; private set; }

        public Task<AuthorizationInfo> GetAuthorizationInfo(HttpContext requestContext)
        {
            CallCount++;
            return Task.FromResult(new AuthorizationInfo { IsAuthenticated = isAuthenticated, User = user });
        }

        public Task<AuthorizationInfo> GetAuthorizationInfo(HttpRequest requestContext)
        {
            return GetAuthorizationInfo(requestContext.HttpContext);
        }
    }
}
