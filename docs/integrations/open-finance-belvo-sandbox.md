# Prova de Open Finance com Belvo Sandbox

## Escopo desta etapa

A integração inicial testa a geração de um token temporário, abre o Hosted Widget da Belvo em português restrito à instituição fictícia `ofmockbank_br_retail`, cria um link único (`access_mode=single`) e valida o ID do vínculo retornado pelo fluxo. O token solicita somente o recurso `ACCOUNTS` para dados fictícios da sandbox e define `stale_in=1d`, que controla a retenção de dados derivados após inatividade, mas não exclui o link. Sem uma configuração específica de `credentials_storage`, a Belvo pode reter credenciais de links únicos por até 365 dias. Depois da validação, uma pessoa responsável pode excluir o vínculo fictício e os dados associados pela própria tela. Não conecta conta real nem grava movimentações no histórico bancário do Shalom.

A Belvo pedirá consentimento para as permissões padrão OFDA `REGISTER`, `ACCOUNTS`, `CREDIT_CARDS` e `CREDIT_OPERATIONS`. A recuperação assíncrona desta prova está limitada ao recurso `ACCOUNTS`; não solicitamos `TRANSACTIONS` nem importamos extratos ou movimentos. A documentação oficial mostra o propósito em duas posições diferentes; o payload envia `purpose` tanto em `widget.purpose` quanto em `widget.consent.purpose` para cobrir ambas.

O endpoint autenticado `belvo-open-finance` oferece as ações `status`, `create_widget_token`, `verify_link` e `delete_link`. A verificação e a exclusão exigem um link cuja identificação opaca foi criada para a mesma pessoa responsável e empresa, além da instituição fixa de sandbox. As credenciais secretas da Belvo são usadas somente na Edge Function. A tela de Conciliação bancária envia nome e CPF fictícios somente para criar o token de teste; esses campos não são persistidos pelo Shalom.

O ID do vínculo de sandbox não é salvo no banco do Shalom. A validação, o resultado e a ação de exclusão aparecem somente na sessão atual; sair ou recarregar a página perde o ID. Após a validação, a tela oferece exclusão explícita do link na Belvo Sandbox; a ação pede confirmação e só aceita um link criado para a pessoa/empresa autenticada e a instituição fictícia deste teste. Exclua o link antes de sair da tela.

O endpoint `belvo-sandbox-webhook` apenas autentica e confirma o recebimento dos eventos com HTTP 202. Ele não armazena eventos, busca recursos adicionais ou importa movimentos.

## Verificação local do webhook

`npm test` inclui uma suíte Deno local para o contrato do webhook: pré-voo, método, segredo ausente, Bearer inválido, JSON e envelope inválidos, corpo acima do limite e evento válido. A suíte usa um token fictício e verifica que o endpoint não faz chamadas externas nem devolve o conteúdo do evento. Ela não chama a Belvo, o Supabase ou a função publicada e não substitui o consentimento de sandbox.

## Pré-requisitos para abrir o widget

Configure os itens abaixo como secrets do projeto Supabase `mnsfdcqcsluhqtzqiiun`. Não coloque valores em arquivos `.env` do frontend, no GitHub ou nesta documentação.

| Secret | Uso |
| --- | --- |
| `BELVO_SANDBOX_SECRET_ID` | Identificador de API da aplicação Belvo Sandbox |
| `BELVO_SANDBOX_SECRET_PASSWORD` | Senha de API da aplicação Belvo Sandbox |
| `BELVO_SANDBOX_TERMS_URL` | URL HTTPS pública dos termos apresentados no consentimento |
| `BELVO_SANDBOX_APP_ORIGIN` | Origem HTTPS pública do Shalom, sem caminho |
| `BELVO_SANDBOX_WEBHOOK_TOKEN` | Token aleatório usado para autenticar chamadas ao webhook na etapa de ingestão |
| `BELVO_SANDBOX_LINK_STATE_SECRET` | Chave aleatória de pelo menos 32 caracteres, estável, usada para autorizar a verificação e exclusão do link da mesma empresa e pessoa responsável |

As credenciais Belvo, as duas URLs, o token do webhook e a chave de estado do link precisam estar configurados antes de criar o token. Mantenha `BELVO_SANDBOX_LINK_STATE_SECRET` estável enquanto houver links de teste que ainda possam precisar de exclusão. A página de termos deve refletir os termos reais aprovados pela empresa; não use uma URL fictícia. A tela consulta a função `status`, que informa quais nomes de configuração estão ausentes sem revelar valores.

Depois de configurar os secrets, publique as Edge Functions `belvo-open-finance` e `belvo-sandbox-webhook` no projeto Supabase. No painel da Belvo, registre a URL pública da função de webhook e configure autenticação Bearer com o mesmo `BELVO_SANDBOX_WEBHOOK_TOKEN`. A Belvo exige um webhook para buscar os recursos solicitados. O endpoint confirma 202 e descarta os eventos; ainda não há busca de transações nem importação para o Shalom.

## Como fazer a prova

1. Abra **Financeiro → Conciliação bancária** com uma conta que tenha papel de responsável pela empresa.
2. Confirme que a tela mostra a sandbox como pronta.
3. Use somente o nome e o CPF fictícios do guia de sandbox da Belvo. A URL limita o widget à instituição de teste `ofmockbank_br_retail`; a Belvo busca somente dados de conta fictícios.
4. Complete o consentimento de teste no widget. O callback de sucesso devolve um ID de link; o Shalom valida esse ID com a Belvo e mostra apenas a instituição e o estado confirmados.
5. Se quiser limpar a prova, use **Excluir vínculo de teste** após a confirmação. A exclusão é permanente para esse link fictício e remove os dados associados na sandbox.
6. Não use credenciais, CPF ou dados de uma conta verdadeira. O Shalom não importa transações nem mantém os dados de conta retornados pelo fluxo.

Para contas empresariais reais, a documentação OFDA da Belvo exige também o CNPJ da empresa e o CPF/nome de uma pessoa autorizada. Essa identificação empresarial não está habilitada neste fluxo de prova individual.

## Próxima etapa antes de qualquer importação

Implementar processamento e persistência de eventos de webhook, busca autenticada dos recursos na Belvo, vínculo por empresa e conta, prevenção de duplicidade, registro de consentimento/retirada e reconciliação explícita. Só depois dessa validação deve ser habilitada a recuperação de transações.

Referências oficiais:

- [Visão geral do Hosted Widget OFDA](https://developers.belvo.com/pt-br/products/aggregation_brazil/ofda-widget-introduction)
- [Configuração inicial do widget (`access_mode` e `external_id`)](https://developers.belvo.com/products/aggregation_brazil/ofda-widget-startup-configuration)
- [Geração do token do widget OFDA](https://developers.belvo.com/pt-br/apis/belvoopenapispec/widget-access-token/generatewidgetaccesstoken)
- [Controles de retenção de dados](https://developers.belvo.com/security/security-data-retention-controls)
- [API de links](https://developers.belvo.com/pt-br/apis/belvoopenapispec/links)
- [Recursos da Sandbox](https://developers.belvo.com/pt-br/developer_resources/resources-sandbox)
- [Webhooks de agregação](https://developers.belvo.com/developer_resources/resources-webhooks-aggregation)
