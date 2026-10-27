# Aurum 2.0

Aplicação de finanças pessoais e organização de cotações, com contas individuais, fornecedores, catálogo de produtos e serviços, comparação de propostas e integração com despesas planejadas.

## Funcionalidades

- Cadastro e login, perfil, troca de senha e sessões revogáveis.
- Receitas, despesas, categorias, orçamentos mensais, objetivos e relatórios com CSV.
- Fornecedores com nome, e-mail, telefone e observações.
- Produtos e serviços com descrição, quantidade padrão e unidade de medida.
- Cotações com até 50 itens e propostas por fornecedor.
- Comparação de valores com quantidade, frete e desconto. Propostas incompletas não recebem indicação de menor total.
- Aprovação de uma proposta e criação de uma despesa pendente. Repetir a aprovação retorna o lançamento existente.
- Interface responsiva, incluindo tabelas com rolagem horizontal no celular.

## Desenvolvimento local

Requisitos: Node.js 24 e pnpm 11.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Abra http://127.0.0.1:3000. Esse comando usa PostgreSQL embarcado via PGlite exclusivamente para desenvolvimento. Os dados ficam em `data/dev`, fora do Git. A chave de sessão é temporária: após reiniciar, entre novamente na conta. Nenhum dado do Railway é copiado ou usado.

## Servidor PostgreSQL / produção

Configure `DATABASE_URL`, `JWT_SECRET` (pelo menos 32 caracteres aleatórios), `NODE_ENV=production` e, opcionalmente, `PORT` e `SESSION_TTL_HOURS` (1 a 168 horas; padrão 12). Para desenvolvimento com PostgreSQL próprio, copie `.env.example` para `.env` e preencha os valores. O comando de início carrega esse arquivo se existir.

```sh
pnpm install --frozen-lockfile --prod
pnpm start
```

O servidor cria as tabelas e adiciona a coluna de vínculo com cotações sem apagar dados existentes. Faça backup do PostgreSQL antes da primeira atualização da 2.0. Para produção, use a rede privada entre aplicação e banco no Railway. A configuração `PGSSLMODE=require` herdada do projeto desativa a validação do certificado: não a use como substituto de uma configuração TLS verificada em bancos públicos.

## Testes

```sh
pnpm test
pnpm audit --prod --audit-level high
```

Por padrão, os testes usam um banco PGlite em memória e o driver `pg` pelo protocolo PostgreSQL. O GitHub Actions executa os mesmos testes com PostgreSQL 16 real. Para usar um banco de testes próprio, configure `AURUM_TEST_DATABASE_URL` apontando para `localhost` ou `127.0.0.1`, com nome terminado em `_test`. Use um banco vazio e descartável; os testes criam dados fictícios.

## Regras de cotações

1. Cadastre fornecedores e produtos/serviços.
2. Crie a cotação e selecione itens e quantidades. A cotação guarda uma cópia da descrição e da unidade para preservar o histórico quando o catálogo mudar.
3. Registre uma proposta por fornecedor, com preços unitários em reais e condições de pagamento/entrega. Atualize os valores com “Editar”.
4. Compare propostas completas. O total soma os itens (arredondados por linha para centavos), acrescenta frete e subtrai desconto. A economia potencial é a diferença entre o maior e o menor total completo. Empates recebem a mesma indicação de menor total.
5. Escolha a proposta, uma categoria de despesa e a data planejada. Aprovar fecha a cotação e gera uma única despesa pendente; não registra pagamento nem movimenta dinheiro. O pagamento é confirmado em Lançamentos.

Uma cotação aprovada não aceita mudanças nas propostas nem exclusão. Se o lançamento financeiro vinculado for excluído, a mesma proposta pode recriá-lo, sem manter dois lançamentos ativos. O usuário pode editar a despesa financeira sem alterar o histórico da proposta. Fornecedores usados em propostas não podem ser excluídos enquanto houver esse vínculo.

## Segurança

As rotas exigem autenticação, segregam os dados por usuário e usam consultas parametrizadas. Alterações exigem CSRF e validação de origem. O servidor limita tentativas e requisições, usa Helmet/CSP e só serve os quatro arquivos públicos da interface. Código do servidor, arquivos de ambiente e testes não são expostos como arquivos estáticos.

## Publicação

A aplicação existente no Railway acompanha `main`. A revisão da 2.0 deve ser aprovada antes da integração. Após o merge, acompanhe o build e verifique `/health`, login e acesso às cotações. Os testes locais não substituem essa verificação no ambiente publicado.
