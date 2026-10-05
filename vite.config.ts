import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import type { Plugin } from 'vite';

function privySessionApiPlugin(): Plugin {
  return {
    name: 'privy-session-api',
    configureServer(server) {
      // The Vercel serverless function in api/privy-session.ts is not executed
      // by `vite dev`, so bridge it here using its native (req, res) handler.
      server.middlewares.use('/api/privy-session', async (req, res) => {
        try {
          const { default: handler } = await import('./api/privy-session');
          await handler(req, res);
        } catch (error) {
          console.error('[v0] privy-session dev middleware error:', error);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Privy session bridge crashed in dev' }));
          }
        }
      });
    },
  };
}

function relayerApiPlugin(): Plugin {
  return {
    name: 'relayer-api',
    configureServer(server) {
      // The Vercel serverless function in api/relayer.ts is not executed by
      // `vite dev`, so bridge it here using its native (req, res) handler —
      // same pattern as privy-session above. Without this, POST /api/relayer
      // falls through to the SPA and the frontend only sees a generic
      // "relayer ... 失敗" with no real error detail.
      server.middlewares.use('/api/relayer', async (req, res) => {
        try {
          const { default: handler } = await import('./api/relayer');
          await handler(req, res);
        } catch (error) {
          console.error('[v0] relayer dev middleware error:', error);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Relayer bridge crashed in dev' }));
          }
        }
      });
    },
  };
}

function adminTelegramMessageApiPlugin(): Plugin {
  return {
    name: 'admin-telegram-message-api',
    configureServer(server) {
      server.middlewares.use('/api/admin-telegram-message', async (req, res) => {
        try {
          const { default: handler } = await import('./api/admin-telegram-message');
          await handler(req, res);
        } catch (error) {
          console.error('[v0] admin Telegram message dev middleware error:', error);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Telegram notification API failed' }));
          }
        }
      });
    },
  };
}

function appVersionPlugin(appVersion: string): Plugin {
  return {
    name: 'app-version',
    configurePreviewServer(server) {
      server.middlewares.use('/api/app-version', (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405;
          res.setHeader('Allow', 'GET, HEAD');
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.end(JSON.stringify({ version: appVersion }));
      });
    },
  };
}

function translationApiPlugin(): Plugin {
  return {
    name: 'translation-api',
    configureServer(server) {
      server.middlewares.use('/api/translate', async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let body: unknown;
        try {
          body = rawBody ? JSON.parse(rawBody) : undefined;
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }
        const { default: handler } = await import('./api/translate');
        const response = {
          status(code: number) {
            res.statusCode = code;
            return response;
          },
          json(value: unknown) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(value));
          },
          setHeader(name: string, value: string) {
            res.setHeader(name, value);
          },
        };
        await handler(
          {
            method: req.method,
            headers: req.headers,
            body,
          },
          response,
        );
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  Object.assign(process.env, env);
  const appVersion = env.VERCEL_DEPLOYMENT_ID || env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || 'local';
  return {
  plugins: [react(), privySessionApiPlugin(), relayerApiPlugin(), adminTelegramMessageApiPlugin(), translationApiPlugin(), appVersionPlugin(appVersion)],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    'process.env.NEXT_PUBLIC_SUPABASE_URL': JSON.stringify(env.NEXT_PUBLIC_SUPABASE_URL),
    'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY': JSON.stringify(env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    'process.env.NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL': JSON.stringify(env.NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL),
    'process.env.NEXT_PUBLIC_PRIVY_APP_ID': JSON.stringify(env.NEXT_PUBLIC_PRIVY_APP_ID),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  server: {
    host: '0.0.0.0',
    hmr: {
      protocol: 'wss',
      clientPort: 443,
    },
  },
};
});
