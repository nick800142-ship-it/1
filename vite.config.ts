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
  return {
  plugins: [react(), privySessionApiPlugin(), translationApiPlugin()],
  define: {
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
