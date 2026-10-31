# Tema visual Shalom Adonai

## Intenção

Trazer para o painel operacional as cores da logo Shalom Adonai e oferecer modos claro e escuro legíveis para formulários, tabelas e navegação.

## Direção aprovada

Usar a direção refinada: modo claro em marfim, navegação marinho, dourado em ações e detalhes; modo escuro em marinho profundo, com superfícies mais claras e texto marfim. O padrão inicial é claro. A seleção fica salva somente no navegador local.

## Tokens de marca

| Token | Cor | Papel |
|---|---|---|
| Navy | `#0B1D38` | Identidade, navegação e texto de alto contraste |
| Navy profundo | `#07172D` | Fundo do modo escuro |
| Navy de superfície | `#102844` | Cartões e superfícies do modo escuro |
| Marfim | `#F5F1E8` | Fundo do modo claro e texto no modo escuro |
| Papel | `#FFFCF6` | Superfícies do modo claro |
| Dourado | `#CBA14A` | Ações primárias, foco e detalhes de marca; texto de botão em navy |
| Verde folha | `#68864A` | Estados positivos, nunca cor principal de navegação |

Neutros, bordas, texto secundário, sombras, aviso e erro recebem tokens semânticos derivados para cada tema. O verde folha aparece em marcadores positivos; texto de sucesso usa tons derivados com contraste suficiente. Dourado não será usado como texto pequeno nem como anel de foco sobre fundo claro: o foco usa um tom de ouro mais escuro no claro e ouro claro no escuro.

## Comportamento

- Um botão de alternância sol/lua aparece na barra superior e na tela de entrada, com rótulo acessível indicando a ação.
- O tema selecionado persiste em `localStorage`; sem escolha salva, iniciar no modo claro.
- A troca altera somente cores e superfícies, em transição curta de cerca de 140 ms. `prefers-reduced-motion` remove a transição.
- O contraste e o estado de foco permanecem visíveis nos dois temas.

## Fora do escopo

Não redesenhar a logo, alterar navegação ou funções de negócio, habilitar cadastro público, adicionar dependências ou mudar dados/serviços remotos.

## Critérios de revisão

Revisar entrada, navegação, tabelas, formulários, estados semânticos, foco de teclado, contraste, uso em telas estreitas e persistência do tema após recarregar. Não adicionar nem executar testes automatizados nesta tarefa.
