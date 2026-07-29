# atf CLI デモ — vhs demo.tape で再生成できます (https://github.com/charmbracelet/vhs)
Output demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1150
Set Height 700
Set Padding 14
Set Theme "Dracula"
Set TypingSpeed 40ms

Hide
Type `export PATH="/private/tmp/claude-501/-Users-takashi-kato-Desktop-with-ai-agent-team-factory/732edd41-6834-4b38-b7ca-9b10dace1717/scratchpad/bin:$PATH" && rm -rf ../demo/awesome-app/.claude && atf --version && clear`
Enter
Sleep 6s
Show

# 1. プリセット一覧
Type "atf list"
Enter
Sleep 5s

# 2. チーム生成(解析 + ヒアリング)
Type "atf generate ../demo/awesome-app"
Enter
Sleep 6s

# 開発フェーズ: 活発に開発中(2 番目)
Down
Sleep 800ms
Enter
Sleep 1500ms

# 重視観点: コード品質 + 開発スピード
Space
Sleep 600ms
Down
Down
Sleep 600ms
Space
Sleep 600ms
Enter
Sleep 1500ms

# チーム規模: 標準構成(2 番目)
Down
Sleep 800ms
Enter
Sleep 1500ms

# Issue 駆動: はい(デフォルト)
Enter
Sleep 2s

# プリセット選択: 推奨 1 位を採用
Enter
Sleep 1500ms

# 導入確認: はい
Enter
Sleep 4s

# 3. 生成されたエージェント定義を確認
Type "ls ../demo/awesome-app/.claude/agents/"
Enter
Sleep 3s

# 4. ダッシュボード生成
Type "atf report ../demo/awesome-app"
Enter
Sleep 5s
