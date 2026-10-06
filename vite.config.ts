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

function telegramAccountApiPlugin(): Plugin {
  return {
    name: 'telegram-account-api',
    configureServer(server) {
      server.middlewares.use('/api/telegram-account', async (req, res) => {
        try {
          const { default: handler } = await import('./api/telegram-account');
          await handler(req, res);
        } catch (error) {
          console.error('[v0] Telegram account dev middleware error:', error);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Telegram account API failed' }));
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

function adminSupportQuestionAnalyticsApiPlugin(): Plugin {
  return {
    name: 'admin-support-question-analytics-api',
    configureServer(server) {
      server.middlewares.use('/api/admin-support-question-analytics', async (req, res) => {
        try {
          const { default: handler } = await import('./api/admin-support-question-analytics');
          await handler(req, res);
        } catch (error) {
          console.error('[v0] support analytics dev middleware error:', error);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: '客服數據服務暫時無法使用，請稍後再試。' }));
          }
        }
      });
    },
  };
}

function telegramOperationsApiPlugin(): Plugin {
  return {
    name: 'telegram-operations-api',
    configureServer(server) {
      server.middlewares.use('/api/telegram-ops-callback', async (req, res) => {
        try {
          const { default: handler } = await import('./api/telegram-ops-callback');
          await handler(req, res);
        } catch (error) {
          console.error('[v0] Telegram operations webhook failed:', error);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: 'Telegram operations webhook failed' }));
          }
        }
      });
      server.middlewares.use('/api/test-telegram', async (req, res) => {
        try {
          const { default: handler } = await import('./api/test-telegram');
          await handler(req, res);
        } catch (error) {
          console.error('[v0] Telegram operations setup failed:', error);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: 'Telegram operations setup failed' }));
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
  plugins: [react(), privySessionApiPlugin(), relayerApiPlugin(), telegramAccountApiPlugin(), adminTelegramMessageApiPlugin(), adminSupportQuestionAnalyticsApiPlugin(), telegramOperationsApiPlugin(), translationApiPlugin(), appVersionPlugin(appVersion)],
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
    allowedHosts: ['.vercel.run'],
    hmr: {
      protocol: 'wss',
      clientPort: 443,
    },
  },
};
});
