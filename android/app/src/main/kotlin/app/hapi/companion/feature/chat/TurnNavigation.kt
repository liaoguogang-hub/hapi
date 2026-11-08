package app.hapi.companion.feature.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.hapi.companion.R
import app.hapi.protocol.chat.UserTextBlock
import app.hapi.protocol.chat.VisibleChatBlock

/**
 * One user turn: the message that opened it, and where it sits in the block
 * list. The transcript renders a history header as row 0, so the row to scroll
 * to is [blockIndex] + 1.
 */
internal data class ChatTurn(
    /** 1-based number shown in the navigator. */
    val index: Int,
    val blockIndex: Int,
    val prompt: String,
)

private val TURN_WHITESPACE = Regex("\\s+")

/**
 * Turns are derived from the transcript itself: every user text block opens a
 * turn. hapi stores no turn boundaries for imported or agent-authored history,
 * and the user message is the only boundary every flavour shares.
 */
internal fun buildChatTurns(blocks: List<VisibleChatBlock>): List<ChatTurn> {
    val turns = ArrayList<ChatTurn>()
    blocks.forEachIndexed { blockIndex, block ->
        val user = block as? UserTextBlock ?: return@forEachIndexed
        val prompt = user.text.replace(TURN_WHITESPACE, " ").trim()
        turns += ChatTurn(index = turns.size + 1, blockIndex = blockIndex, prompt = prompt)
    }
    return turns
}

/** Turn list behind the top-bar button: number + prompt, tap to jump. */
@Composable
internal fun TurnListDialog(
    turns: List<ChatTurn>,
    onPick: (ChatTurn) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.chat_turns_title, turns.size)) },
        text = {
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 420.dp)) {
                items(turns, key = { it.index }) { turn ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .pointerInput(turn.index) { detectTapGestures { onPick(turn) } }
                            .padding(vertical = 10.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Text(
                            text = turn.index.toString(),
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.width(28.dp),
                        )
                        Text(
                            text = turn.prompt.ifBlank { stringResource(R.string.chat_turn_no_prompt) },
                            fontSize = 13.sp,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            color = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.home_cancel)) }
        },
    )
}

/**
 * Desktop-style turn rail down the right edge: one tick per turn. Tap a tick to
 * jump, or press and slide to scrub; the tick under the finger grows and a
 * counter shows which turn is selected.
 */
@Composable
internal fun TurnRail(
    turns: List<ChatTurn>,
    onPick: (ChatTurn) -> Unit,
    modifier: Modifier = Modifier,
) {
    var selected by remember(turns.size) { mutableIntStateOf(-1) }
    var scrubbing by remember(turns.size) { mutableStateOf(false) }

    fun indexAt(y: Float, height: Float): Int {
        if (turns.isEmpty() || height <= 0f) return -1
        return ((y / height) * turns.size).toInt().coerceIn(0, turns.size - 1)
    }

    fun pick(index: Int) {
        if (index in turns.indices && index != selected) {
            selected = index
            onPick(turns[index])
        }
    }

    Box(modifier = modifier.width(24.dp).fillMaxHeight(), contentAlignment = Alignment.Center) {
        Column(
            modifier = Modifier
                .fillMaxHeight()
                .width(24.dp)
                .pointerInput(turns.size) {
                    detectTapGestures { offset -> pick(indexAt(offset.y, size.height.toFloat())) }
                }
                .pointerInput(turns.size) {
                    detectVerticalDragGestures(
                        onDragStart = { offset ->
                            scrubbing = true
                            pick(indexAt(offset.y, size.height.toFloat()))
                        },
                        onDragEnd = { scrubbing = false },
                        onDragCancel = { scrubbing = false },
                    ) { change, _ ->
                        pick(indexAt(change.position.y, size.height.toFloat()))
                    }
                },
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            turns.forEachIndexed { index, _ ->
                val active = index == selected
                Box(
                    Modifier
                        .padding(vertical = 2.5.dp)
                        .width(if (active) 16.dp else 10.dp)
                        .height(if (active) 6.dp else 3.dp)
                        .background(
                            if (active) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.primary.copy(alpha = 0.35f)
                            },
                            RoundedCornerShape(3.dp),
                        ),
                )
            }
        }
        if (scrubbing && selected in turns.indices) {
            Surface(
                color = MaterialTheme.colorScheme.inverseSurface,
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier.padding(end = 22.dp),
            ) {
                Text(
                    text = stringResource(R.string.chat_turn_position, selected + 1, turns.size),
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium,
                    color = MaterialTheme.colorScheme.inverseOnSurface,
                )
            }
        }
    }
}
