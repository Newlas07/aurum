# Publicação e recuperação do Aurum 2.0

## Ambiente público de testes

URL: https://aurum-no1c.onrender.com

A aplicação está no plano gratuito do Render, serviço srv-dbg07mek1f9s73aumgcg. O banco PostgreSQL 18 está no projeto AURUM do Neon, plano gratuito. O usuário escolheu essa alternativa ao Railway para compartilhar um teste. Não foi contratado plano pago e não foi importado ou apagado o banco antigo.

O primeiro deploy usa o commit ff840d7ebe9d8e5801b953f574ea9af286feccd7. A versão respondeu /health com HTTP 200, ok=true e version=2.0.0. O teste completo público passou por cadastro, login, cookies Secure/HttpOnly/SameSite, API sem cache, cabeçalhos de proteção, fornecedores, produtos, comparação e duas aprovações simultâneas gerando uma única despesa pendente. A própria conta temporária foi removida ao terminar. O tema escuro também foi conferido no navegador publicado.

O Render suspende serviços gratuitos após inatividade; a próxima abertura pode demorar 50 segundos ou mais. O banco Neon tem limites de uso e armazenamento. Este ambiente é para testes; o plano gratuito não substitui uma política própria de backups e recuperação para dados reais.

## Configuração

render.yaml descreve o plano gratuito, Node.js 24, modo de produção, verificação /health e TLS do banco com certificado validado. DATABASE_URL é um segredo do serviço Render; JWT_SECRET é aleatório. Nenhuma credencial deve entrar no repositório, mensagens, capturas ou relatórios.

O serviço inicial aponta para a branch de revisão. Após a integração aprovada, configurar o Render para acompanhar main. Antes de futuras atualizações: conferir os testes, a revisão das mudanças e o plano de recuperação. Depois: conferir /health, login, isolamento de contas, cotações e logs sem divulgar conteúdo pessoal.

## Recuperação

Falha de inicialização, perda de login, acesso indevido a outra conta, duplicação de despesa ou falha do banco são motivos para interromper uma atualização. Voltar ao último deploy válido pelo Render. Alterações aditivas no banco podem permanecer; não apagar tabelas para reverter o aplicativo.

Após migração de senhas para scrypt, usar uma versão 2.0 que preserve passwords.cjs. A versão 1.0 só lê bcrypt e não é uma reversão segura para contas já migradas. O commit original de main é 98b2b3dad2cc3c76ad9531c174fdbbd14c25792f.

Não foi executada uma restauração destrutiva. Para dados reais, configurar cópias de segurança e testar a restauração em um banco separado antes de depender deste ambiente.

## Railway antigo

O painel autenticado mostrou período de teste expirado, dois serviços sem execução ativa e nenhum backup no volume. A interface exigia Pro para criar novos backups. O projeto antigo foi preservado. Reativação ou migração dos dados existentes exige verificar sua disponibilidade e exportá-los antes de qualquer alteração; não confundir o novo banco de testes com a recuperação do banco antigo.
