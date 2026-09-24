# Segurança do Aurum

O Aurum é um aplicativo de finanças pessoais. Ele não deve coletar senhas bancárias, números completos de cartão, tokens bancários, chaves privadas, códigos de autenticação ou credenciais de instituições financeiras.

## Controles atuais
- Senhas armazenadas com bcrypt.
- Cookies de autenticação com HttpOnly, Secure em produção e SameSite.
- Proteção CSRF.
- Helmet e Content Security Policy.
- Rate limiting em autenticação.
- Consultas SQL parametrizadas.
- Autorização por usuário em todas as entidades.
- PostgreSQL persistente no Railway.
- Segredos fora do GitHub.

## Regras operacionais
- Use MFA no GitHub e Railway.
- Nunca salve segredos no repositório.
- Rode npm audit regularmente.
- Mantenha dependências atualizadas.
- Revise logs e falhas de autenticação.
- Mantenha backups do PostgreSQL e teste restauração.
- Não registre senhas, tokens de sessão ou conteúdo financeiro sensível em logs.

## Segurança contínua
Nenhuma aplicação pode ser declarada “100% segura”. Mudanças futuras devem passar por revisão de autenticação, autorização, validação de entrada, dependências, logs e configuração de produção.
