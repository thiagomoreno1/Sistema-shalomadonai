# Prova de Open Finance com Belvo Sandbox

## Escopo desta etapa

A integração inicial testa a geração de um token temporário, abre o Hosted Widget da Belvo em português restrito à instituição fictícia `ofmockbank_br_retail` e valida o ID do vínculo retornado pelo fluxo. O token solicita somente o recurso `ACCOUNTS` para dados fictícios da sandbox e define retenção Belvo de `1d`. Não solicita `TRANSACTIONS`, não conecta conta real e não grava movimentações no histórico bancário do Shalom.

A Belvo exige que a tela OFDA mostre as permissões padrão `REGISTER`, `ACCOUNTS`, `CREDIT_CARDS` e `CREDIT_OPERATIONS`. A recuperação assíncrona desta prova está limitada ao recurso `ACCOUNTS`.

O endpoint autenticado `belvo-open-finance` oferece as ações `status`, `create_widget_token` e `verify_link`. As credenciais secretas da Belvo são usadas somente na Edge Function. A tela de Conciliação bancária envia nome e CPF fictícios somente para criar o token de teste; esses campos não são persistidos pelo Shalom.

O ID do vínculo de sandbox também não é persistido. A validação e o resultado aparecem somente na sessão atual; sair ou recarregar a página exige iniciar uma nova prova.

O endpoint `belvo-sandbox-webhook` apenas autentica e confirma o recebimento dos eventos com HTTP 202. Ele não armazena eventos, busca recursos adicionais ou importa movimentos.

## Pré-requisitos para abrir o widget

Configure os itens abaixo como secrets do projeto Supabase `mnsfdcqcsluhqtzqiiun`. Não coloque valores em arquivos `.env` do frontend, no GitHub ou nesta documentação.

| Secret | Uso |
| --- | --- |
| `BELVO_SANDBOX_SECRET_ID` | Identificador de API da aplicação Belvo Sandbox |
| `BELVO_SANDBOX_SECRET_PASSWORD` | Senha de API da aplicação Belvo Sandbox |
| `BELVO_SANDBOX_TERMS_URL` | URL HTTPS pública dos termos apresentados no consentimento |
| `BELVO_SANDBOX_APP_ORIGIN` | Origem HTTPS pública do Shalom, sem caminho |
| `BELVO_SANDBOX_WEBHOOK_TOKEN` | Token aleatório usado para autenticar chamadas ao webhook na etapa de ingestão |

As credenciais Belvo, as duas URLs e o token de autenticação do webhook precisam estar configurados antes de criar o token. A página de termos deve refletir os termos reais aprovados pela empresa; não use uma URL fictícia. A tela consulta a função `status`, que informa quais nomes de configuração estão ausentes sem revelar valores.

Depois de configurar os secrets, publique as Edge Functions `belvo-open-finance` e `belvo-sandbox-webhook` no projeto Supabase. No painel da Belvo, registre a URL pública da função de webhook e configure autenticação Bearer com o mesmo `BELVO_SANDBOX_WEBHOOK_TOKEN`. A Belvo exige um webhook para buscar os recursos solicitados. O endpoint confirma 202 e descarta os eventos; ainda não há busca de transações nem importação para o Shalom.

## Como fazer a prova

1. Abra **Financeiro → Conciliação bancária** com uma conta que tenha papel de responsável pela empresa.
2. Confirme que a tela mostra a sandbox como pronta.
3. Use somente o nome e o CPF fictícios do guia de sandbox da Belvo. A URL limita o widget à instituição de teste `ofmockbank_br_retail`; a Belvo busca somente dados de conta fictícios.
4. Complete o consentimento de teste no widget. O callback de sucesso devolve um ID de link; o Shalom valida esse ID com a Belvo e mostra apenas a instituição e o estado confirmados.
5. Não use credenciais, CPF ou dados de uma conta verdadeira. O Shalom não importa transações nem mantém os dados de conta retornados pelo fluxo.

Para contas empresariais reais, a documentação OFDA da Belvo exige também o CNPJ da empresa e o CPF/nome de uma pessoa autorizada. Essa identificação empresarial não está habilitada neste fluxo de prova individual.

## Próxima etapa antes de qualquer importação

Implementar processamento e persistência de eventos de webhook, busca autenticada dos recursos na Belvo, vínculo por empresa e conta, prevenção de duplicidade, registro de consentimento/retirada e reconciliação explícita. Só depois dessa validação deve ser habilitada a recuperação de transações.

Referências oficiais:

- [Visão geral do Hosted Widget OFDA](https://developers.belvo.com/pt-br/products/aggregation_brazil/ofda-widget-introduction)
- [Geração do token do widget OFDA](https://developers.belvo.com/pt-br/apis/belvoopenapispec/widget-access-token/generatewidgetaccesstoken)
- [Recursos da Sandbox](https://developers.belvo.com/pt-br/developer_resources/resources-sandbox)
- [Webhooks de agregação](https://developers.belvo.com/developer_resources/resources-webhooks-aggregation)
