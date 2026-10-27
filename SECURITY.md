# Segurança do Aurum

O Aurum é um aplicativo de finanças pessoais. Ele não deve coletar senhas bancárias, números completos de cartão, tokens bancários, chaves privadas, códigos de autenticação ou credenciais de instituições financeiras.

## Controles atuais
- Senhas novas em scrypt (N=65536, r=8, p=2, salt aleatório de 16 bytes). Hashes bcrypt legados são aceitos e atualizados após login correto. Senhas legadas acima do limite histórico de 72 bytes do bcrypt só passam a ser distinguidas integralmente após essa atualização ou troca de senha.
- Cookies de autenticação com HttpOnly, Secure em produção e SameSite.
- CSRF HMAC-SHA256 vinculado ao identificador da sessão, comparação em tempo constante e validação de origem.
- Helmet e Content Security Policy.
- Rate limiting de API, autenticação e confirmação de senha; bloqueio progressivo no banco com incremento atômico. Processamento de senha limitado a duas operações simultâneas e fila limitada.
- Consultas SQL parametrizadas.
- Autorização por usuário em todas as entidades.
- PostgreSQL persistente no Railway.
- Segredos fora do GitHub.
- Tokens JWT restritos a HS256, issuer/audience e sessão válida no banco. Logout, expiração e troca de senha invalidam sessões.
- API com Cache-Control: no-store, JSON limitado a 50 KB e validação de datas, valores, quantidades e IDs.
- Aprovação financeira com transação, bloqueio de linha, vínculo único e auditoria na mesma transação.
- Exclusão de conta transacional, removendo cotações antes dos fornecedores vinculados e preservando contas alheias.
- Bancos públicos exigem TLS validado; timeouts limitam conexões e consultas.
- Download restrito aos arquivos públicos; contatos e descrições escapados no HTML; fórmulas neutralizadas no CSV, inclusive com espaços iniciais.

## Regras operacionais
- Use MFA no GitHub e Railway.
- Nunca salve segredos no repositório.
- Rode pnpm audit --prod --audit-level high regularmente.
- Mantenha dependências atualizadas.
- Revise logs e falhas de autenticação.
- Mantenha backups do PostgreSQL e teste restauração.
- Não registre senhas, tokens de sessão ou conteúdo financeiro sensível em logs.

## Segurança contínua
Nenhuma aplicação pode ser declarada “100% segura”. Mudanças futuras devem passar por revisão de autenticação, autorização, validação de entrada, dependências, logs e configuração de produção.

Os testes cobrem controles da aplicação; não são uma certificação nem um pentest independente. A CSP ainda permite estilos inline necessários aos gráficos, mas bloqueia scripts inline. Os limites por IP/conta usam memória do processo; múltiplas réplicas exigem um armazenamento compartilhado para esses limites. Logs de auditoria e sessões precisam de política operacional de retenção. MFA do próprio aplicativo, recuperação de senha e verificação de e-mail não fazem parte desta versão.

