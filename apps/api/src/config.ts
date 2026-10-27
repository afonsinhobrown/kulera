export interface AppConfig {
  nodeEnv: string;
  port: number;
  paysuiteWebhookSecret: string;
  paysuiteBaseUrl: string;
  paysuiteToken: string;
  paysuiteCreatePath: string;
  paysuiteGetPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProd = nodeEnv === 'production';

  const required = (name: string, onlyInProd = false): string => {
    const value = env[name];
    if (value && value.trim() !== '') return value;
    if (onlyInProd && !isProd) return '';
    throw new Error(`Variável de ambiente em falta: ${name}`);
  };

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('PORT inválida');
  }

  return {
    nodeEnv,
    port,
    paysuiteWebhookSecret: required('PAYSUITE_WEBHOOK_SECRET'),
    paysuiteBaseUrl: required('PAYSUITE_BASE_URL', true),
    paysuiteToken: required('PAYSUITE_TOKEN', true),
    paysuiteCreatePath: env.PAYSUITE_CREATE_PATH ?? '/payments',
    paysuiteGetPath: env.PAYSUITE_GET_PATH ?? '/payments/:id',
  };
}
