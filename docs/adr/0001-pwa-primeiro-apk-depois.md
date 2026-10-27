# ADR-0001 — Web responsiva (PWA) primeiro e APK Android depois

- **Estado**: Decidido (promotor)
- **Decisores**: Editora Kulera

## Contexto
Os leitores usam telemóvel e laptop (por exemplo, a ler em cafés) e muitos instalam apps por APK, fora da Play Store.

## Decisão
Construir primeiro uma aplicação web responsiva (PWA) com um único backend; depois empacotá-la como APK Android assinado e distribuído numa página de download oficial.

## Consequências
Um só código serve todos os dispositivos. O APK não se actualiza sozinho: a app deve avisar de novas versões (RF-APK-02). A chave de assinatura tem de estar em cofre com pelo menos duas pessoas com acesso.
