import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl, Modal, TextInput, ScrollView, Alert } from 'react-native';
import { Api } from '../api';
import { colors } from '../theme';

const RECURRENCES = ['none', 'daily', 'weekly', 'monthly'];

// Chores are visible to every role, including children — kids need to see
// their own assignments and the family's overall list. Only Admin/Member can
// create, edit, or delete chores; anyone can complete the ones assigned to them.
export default function ChoresScreen({ user, familyId, members }) {
  const [chores, setChores] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const canManage = user.role !== 'child';

  const load = useCallback(async () => {
    try {
      const r = await Api.chores(familyId);
      setChores(r.chores);
    } catch (e) {
      Alert.alert('Could not load chores', e.message);
    }
  }, [familyId]);

  useEffect(() => { load(); }, [load]);
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const assigneeName = (id) => { const m = members.find((x) => x.id === id); return m ? m.name.split(' ')[0] : 'Unassigned'; };
  const pending = chores.filter((c) => c.status === 'pending');
  const completed = chores.filter((c) => c.status === 'completed');

  const complete = async (id) => {
    try {
      const r = await Api.completeChore(id);
      Alert.alert('Nice work!', r.pointsAwarded ? `+${r.pointsAwarded} points` : 'Chore completed');
      load();
    } catch (e) {
      Alert.alert('Error', e.message);
    }
  };
  const remove = (id) => Alert.alert('Delete chore?', '', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: async () => { await Api.deleteChore(id); load(); } },
  ]);

  const renderChore = (c) => {
    const isMine = c.assigneeId === user.id;
    const canComplete = c.status === 'pending' && (isMine || user.role === 'admin');
    return (
      <View key={c.id} style={styles.card}>
        <View style={{ flex: 1 }}>
          <Text style={styles.choreTitle}>{c.title}</Text>
          <Text style={styles.meta}>
            {c.description ? c.description + ' · ' : ''}👤 {assigneeName(c.assigneeId)} · {c.points} pts
            {c.dueDate ? ` · due ${c.dueDate}` : ''}{c.recurrence !== 'none' ? ` · ${c.recurrence}` : ''}
          </Text>
        </View>
        {c.status === 'completed' && <View style={styles.doneBadge}><Text style={styles.doneBadgeText}>done</Text></View>}
        {canComplete && (
          <TouchableOpacity style={styles.completeBtn} onPress={() => complete(c.id)}>
            <Text style={styles.completeBtnText}>Done</Text>
          </TouchableOpacity>
        )}
        {canManage && (
          <TouchableOpacity onPress={() => remove(c.id)}><Text style={styles.deleteText}>✕</Text></TouchableOpacity>
        )}
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Chores</Text>
          <Text style={styles.subtitle}>{pending.length} pending · {completed.length} completed</Text>
        </View>
        {canManage && (
          <TouchableOpacity style={styles.addBtn} onPress={() => setModalOpen(true)}>
            <Text style={styles.addBtnText}>+ Add</Text>
          </TouchableOpacity>
        )}
      </View>
      <FlatList
        data={[{ key: 'pending', label: 'To do', items: pending }, { key: 'completed', label: 'Recently completed', items: completed.slice(0, 10) }]}
        keyExtractor={(s) => s.key}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        contentContainerStyle={{ padding: 16 }}
        renderItem={({ item: section }) => (
          <View style={{ marginBottom: 16 }}>
            <Text style={styles.dayLabel}>{section.label}</Text>
            {section.items.length ? section.items.map(renderChore) : <Text style={styles.empty}>Nothing here.</Text>}
          </View>
        )}
      />
      <ChoreModal visible={modalOpen} members={members} familyId={familyId}
        onClose={() => setModalOpen(false)} onSaved={() => { setModalOpen(false); load(); }} />
    </View>
  );
}

function ChoreModal({ visible, members, familyId, onClose, onSaved }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assigneeId, setAssigneeId] = useState(null);
  const [recurrence, setRecurrence] = useState('none');
  const [dueDate, setDueDate] = useState('');
  const [points, setPoints] = useState('5');

  const save = async () => {
    if (!title.trim()) return Alert.alert('Title required');
    try {
      await Api.createChore(familyId, {
        title, description, assigneeId, recurrence,
        dueDate: dueDate || null, points: Number(points) || 0,
      });
      setTitle(''); setDescription(''); setDueDate('');
      onSaved();
    } catch (e) {
      Alert.alert('Error', e.message);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 20, paddingTop: 56 }}>
        <Text style={styles.heading}>Add a chore</Text>
        <Text style={styles.label}>Title</Text>
        <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="e.g. Take out the trash" />
        <Text style={styles.label}>Description</Text>
        <TextInput style={styles.input} value={description} onChangeText={setDescription} placeholder="optional" />
        <Text style={styles.label}>Assign to</Text>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {members.map((m) => (
            <TouchableOpacity key={m.id} onPress={() => setAssigneeId(m.id)} style={[styles.pill, assigneeId === m.id && styles.pillActive]}>
              <Text style={[styles.pillText, assigneeId === m.id && styles.pillTextActive]}>{m.name.split(' ')[0]}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.label}>Recurrence</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
          {RECURRENCES.map((r) => (
            <TouchableOpacity key={r} onPress={() => setRecurrence(r)} style={[styles.pill, recurrence === r && styles.pillActive]}>
              <Text style={[styles.pillText, recurrence === r && styles.pillTextActive]}>{r}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.label}>Due date (YYYY-MM-DD, optional)</Text>
        <TextInput style={styles.input} value={dueDate} onChangeText={setDueDate} placeholder="optional" />
        <Text style={styles.label}>Points</Text>
        <TextInput style={styles.input} value={points} onChangeText={setPoints} keyboardType="number-pad" />
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 24 }}>
          <TouchableOpacity style={[styles.btn, { backgroundColor: colors.border, flex: 0 }]} onPress={onClose}>
            <Text style={[styles.btnText, { color: colors.text }]}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btn, { backgroundColor: colors.primary, flex: 1 }]} onPress={save}>
            <Text style={styles.btnText}>Save</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, paddingTop: 56, backgroundColor: colors.card, borderBottomWidth: 1, borderColor: colors.border },
  title: { fontSize: 20, fontWeight: '800', color: colors.text },
  subtitle: { fontSize: 12, color: colors.muted },
  addBtn: { backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  addBtnText: { color: 'white', fontWeight: '700', fontSize: 13 },
  dayLabel: { fontSize: 12, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', marginBottom: 8 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border },
  choreTitle: { fontWeight: '700', fontSize: 14, color: colors.text },
  meta: { fontSize: 12, color: colors.muted, marginTop: 2 },
  doneBadge: { backgroundColor: '#e7f8f0', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  doneBadgeText: { fontSize: 10, fontWeight: '700', color: '#047857' },
  completeBtn: { backgroundColor: colors.primary, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  completeBtnText: { color: 'white', fontSize: 12, fontWeight: '700' },
  deleteText: { color: colors.red, fontSize: 16, fontWeight: '700', paddingHorizontal: 4 },
  empty: { textAlign: 'center', color: colors.muted, marginTop: 10 },
  heading: { fontSize: 20, fontWeight: '800', marginBottom: 16 },
  label: { fontSize: 12, fontWeight: '700', color: colors.muted, marginBottom: 6, marginTop: 10 },
  input: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, fontSize: 14 },
  pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  pillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  pillText: { fontSize: 12, color: colors.text },
  pillTextActive: { color: 'white', fontWeight: '700' },
  btn: { paddingVertical: 12, borderRadius: 10, alignItems: 'center', paddingHorizontal: 16 },
  btnText: { color: 'white', fontWeight: '700' },
});
