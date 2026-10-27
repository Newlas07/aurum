# Publicação e recuperação do Aurum 2.0

## Antes da integração

- Testes locais e GitHub Actions devem passar com PostgreSQL 16 e 18.
- Backup do PostgreSQL existente deve estar confirmado no painel Railway antes do primeiro deploy.
- A migração adiciona tabelas e uma coluna opcional, preservando os dados financeiros existentes. Não executar scripts de teste no banco de produção.
- Guardar o commit anterior de main: 98b2b3dad2cc3c76ad9531c174fdbbd14c25792f.
- O usuário autorizou integração e publicação após a revisão de segurança e os temas.

## Verificações de publicação

1. Integrar o PR aprovado; a aplicação Railway acompanha main.
2. Aguardar build e deploy em estado SUCCESS.
3. Verificar GET /health: HTTP 200, ok=true e version=2.0.0. Esse endpoint consulta o banco.
4. Verificar login, dados isolados, fornecedores, catálogo, comparação, aprovação idempotente e temas.
5. Conferir Cache-Control, CSP, cabeçalhos de proteção e Secure/HttpOnly/SameSite nos cookies de autenticação.
6. Conferir logs para erros de inicialização, auditoria e banco. Não copiar dados pessoais ou credenciais para relatórios públicos.

## Recuperação

Falha de inicialização, perda de login, acesso indevido a outra conta, duplicação de despesa ou falha de banco são motivos para interromper a atualização. Reaplicar o último build válido pelo painel Railway. As alterações aditivas do banco podem permanecer; não apagar tabelas para reverter o aplicativo. Após migração de senha para scrypt, usar um build da 2.0 que preserve passwords.cjs — a versão 1.0 só lê bcrypt e não é um rollback seguro para contas já migradas.

Para perda ou corrupção de dados, restaurar o backup do volume pelo painel Railway, conferindo a data, ambiente e serviço. A restauração troca o volume montado e pode descartar alterações posteriores ao backup; deve ser executada pelo responsável após avaliar essa perda. Este procedimento documentado não equivale a um teste real de restauração do banco de produção.
