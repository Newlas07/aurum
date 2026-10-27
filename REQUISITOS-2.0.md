# Escopo confirmado do Aurum 2.0

Fonte: etapas 7 a 13 fornecidas pelo usuário em 26/10/2026. O histórico recuperado confirma a base de finanças pessoais, autenticação e segurança. O trecho fornecido pelo usuário resolve a lacuna do plano de cotações.

| Etapa | Requisito | Implementação |
| --- | --- | --- |
| 7 | Finalizar fornecedores | Tela ligada à API, listagem, cadastro, edição e exclusão |
| 8 | Produtos e serviços | Catálogo com descrição, quantidade e unidade |
| 9 | Cotações | Vários itens, propostas de fornecedores, preços e condições |
| 10 | Comparação | Menor total completo, empates e economia potencial |
| 11 | Integração financeira | Aprovação cria despesa pendente com vínculo único |
| 12 | Testes e segurança | Testes HTTP/SQL de autenticação, permissões, cálculos e duplicação; verificação visual desktop e celular |
| 13 | Publicação | Ambiente de testes publicado no Render com PostgreSQL Neon; substitui Railway conforme decisão do usuário |

Decisões de implementação: preços em centavos, quantidade com até três casas decimais, limite de 50 itens por cotação, uma proposta editável por fornecedor, comparação incluindo frete/desconto e preservação do histórico dos itens. A economia usa a proposta completa mais cara como referência. Essas regras estão explicadas na interface e no README.

Não fazem parte destas etapas: envio automático de e-mails a fornecedores, pagamentos, conexão com bancos, autenticação em dois fatores, aplicativo nativo e inteligência artificial. Os últimos itens aparecem no histórico como evolução futura, sem especificação para esta entrega.
