try {
  await Promise.all(['@whiskeysockets/baileys', 'pino', 'qrcode'].map((name) => import(name)));
  console.log('WhatsApp: dependencias carregadas com sucesso.');
} catch {
  console.error(
    'Dependencias do WhatsApp ausentes ou invalidas. Execute INSTALAR.bat e confira a conexao de rede.',
  );
  process.exitCode = 1;
}
