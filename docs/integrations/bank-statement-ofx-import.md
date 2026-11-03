# Importação de extrato OFX/QFX

## O que faz

A conciliação bancária pode receber um extrato em `.ofx` ou `.qfx`. O arquivo é interpretado localmente no navegador e aparece em uma prévia antes de qualquer gravação. O responsável seleciona uma conta já cadastrada, confere os últimos quatro dígitos quando disponíveis e confirma a importação. Depois disso, os movimentos entram como `statement_file`; nenhuma conciliação com pedido ou despesa é feita automaticamente.

## Formatos aceitos

- OFX 1.x (SGML) e OFX 2.x (XML), para extrato bancário com uma única conta e moeda `BRL`.
- Codificação UTF-8 ou Windows-1252 declarada no cabeçalho.
- Arquivos `.ofx` e `.qfx` de até 5 MiB e até 1.000 movimentações.
- Cada movimento precisa ter FITID, data válida não futura, valor diferente de zero em centavos e descrição compatível com os campos da conciliação.

O FITID é o identificador fornecido pela instituição para cada movimento. A [especificação bancária OFX 2.3](https://financialdataexchange.org/common/Uploaded%20files/OFX%20files/OFX%20Banking%20Specification%20v2.3.pdf) descreve seu uso para detectar respostas repetidas e informa que sua unicidade é por conta. O Shalom combina esse identificador com a empresa, a conta selecionada e a origem do movimento. A coluna existente limita o FITID a 200 caracteres.

## Privacidade e duplicidades

O arquivo original e o número completo da conta ficam somente na memória do navegador durante a leitura. O Shalom não envia o arquivo para armazenamento nem registra o número completo da conta. Após a confirmação, o navegador envia somente data, valor assinado em centavos, descrição, contraparte opcional e FITID. O banco grava os movimentos e um lote agregado com contagens e autoria; não grava linhas brutas do arquivo.

FITIDs repetidos dentro do arquivo são contados e ignorados após a primeira ocorrência. O banco também ignora FITIDs já registrados para a mesma empresa e conta. O identificador da tentativa protege a gravação quando a conexão cai depois do envio: reenviar a mesma tentativa retorna o resultado do lote, sem repetir movimentos.

## Limites e estado de implantação

A importação não altera recebimentos, despesas ou resultado gerencial, e não marca movimentos como conciliados. Arquivos com moeda, conta, codificação, dados ou limites incompatíveis precisam ser corrigidos/exportados novamente pelo banco.

O parser, a interface e a migração estão no repositório. A migração ainda não foi aplicada ao Supabase hospedado; até sua aprovação e aplicação, o RPC não estará disponível no ambiente conectado. A validação com um arquivo bancário real também está pendente. Não inclua extratos reais em commits ou chamados de suporte.
