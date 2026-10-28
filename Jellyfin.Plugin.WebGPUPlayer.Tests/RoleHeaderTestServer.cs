using System;
using System.IO;
using System.Net.Http;
using System.Security.Claims;
using System.Text.Encodings.Web;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

// A test server of the plugin's controllers whose requests sign in with the role a header names
internal static class RoleHeaderTestServer
{
    public const string AdministratorRole = "Administrator";
    public const string UserRole = "User";

    private const string TestScheme = "Test";
    // The request header that names the test user's role; a request without it is anonymous
    private const string RoleHeader = "X-Test-Role";

    public static async Task<WebApplication> StartAsync(Action<IServiceCollection> addServices, CancellationToken cancellationToken)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        addServices(builder.Services);
        // The server's own policies elevate administrators; the test scheme stands in for its authentication
        builder.Services.AddAuthentication(TestScheme).AddScheme<AuthenticationSchemeOptions, RoleHeaderAuthenticationHandler>(TestScheme, null);
        builder.Services.AddAuthorization(options => options.AddPolicy(Policies.RequiresElevation, policy => policy.RequireRole(AdministratorRole)));
        builder.Services.AddControllers().AddApplicationPart(typeof(Plugin).Assembly);
        WebApplication application = builder.Build();
        // TestServer enforces no request body size limit, so a route's limit applies here as Kestrel applies it
        application.Use((context, next) =>
        {
            BodySizeLimit limit = new BodySizeLimit(context.Request.Body);
            context.Features.Set<IHttpMaxRequestBodySizeFeature>(limit);
            context.Request.Body = limit.Body;
            return next(context);
        });
        application.UseAuthentication();
        application.UseAuthorization();
        application.MapControllers();
        await application.StartAsync(cancellationToken);
        return application;
    }

    public static HttpClient CreateClient(WebApplication application, string role)
    {
        HttpClient client = application.GetTestClient();
        client.DefaultRequestHeaders.Add(RoleHeader, role);
        return client;
    }

    // Signs a request in with the role its header names
    private sealed class RoleHeaderAuthenticationHandler(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
        : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
    {
        protected override Task<AuthenticateResult> HandleAuthenticateAsync()
        {
            string? role = Request.Headers[RoleHeader];
            if (string.IsNullOrEmpty(role))
            {
                return Task.FromResult(AuthenticateResult.NoResult());
            }

            ClaimsIdentity identity = new ClaimsIdentity([new Claim(ClaimTypes.Name, role), new Claim(ClaimTypes.Role, role)], TestScheme);
            return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), TestScheme)));
        }
    }

    // Kestrel's request body size limit: a read past the limit a route sets throws, as Kestrel's body stream does
    private sealed class BodySizeLimit : IHttpMaxRequestBodySizeFeature
    {
        // Kestrel's default limit
        private const long DefaultMaximumByteLength = 30_000_000;

        public BodySizeLimit(Stream body)
        {
            Body = new LimitedStream(body, this);
        }

        public Stream Body { get; }

        public bool IsReadOnly => false;

        public long? MaxRequestBodySize { get; set; } = DefaultMaximumByteLength;

        private sealed class LimitedStream(Stream inner, BodySizeLimit limit) : Stream
        {
            private long readByteLength;

            public override bool CanRead => true;

            public override bool CanSeek => false;

            public override bool CanWrite => false;

            public override long Length => throw new NotSupportedException();

            public override long Position
            {
                get => throw new NotSupportedException();
                set => throw new NotSupportedException();
            }

            public override int Read(byte[] buffer, int offset, int count)
            {
                return Count(inner.Read(buffer, offset, count));
            }

            public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
            {
                return Count(await inner.ReadAsync(buffer, cancellationToken).ConfigureAwait(false));
            }

            public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            {
                return ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
            }

            public override void Flush()
            {
            }

            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

            public override void SetLength(long value) => throw new NotSupportedException();

            public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

            private int Count(int byteLength)
            {
                readByteLength += byteLength;
                if (readByteLength > limit.MaxRequestBodySize)
                {
                    throw new BadHttpRequestException("Request body too large. The max request body size is " + limit.MaxRequestBodySize + " bytes.", StatusCodes.Status413PayloadTooLarge);
                }

                return byteLength;
            }
        }
    }
}
