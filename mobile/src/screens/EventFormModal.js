import React, { useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Switch, Alert } from 'react-native';
import { Api } from '../api';
import { colors, initials } from '../theme';
import { scheduleEventReminder } from '../notifications';

export default function EventFormModal({ visible, onClose, existing, members, familyId, onSaved }) {
  const [title, setTitle] = useState(existing?.title || '');
  const [location, setLocation] = useState(existing?.location || '');
  const [description, setDescription] = useState(existing?.description || '');
  const [recurrence, setRecurrence] = useState(existing?.recurrence || 'none');
  const [category, setCategory] = useState(existing?.category || 'general');
  const [provider, setProvider] = useState(existing?.provider || '');
  const [assignees, setAssignees] = useState(new Set((existing?.assignees || []).map((a) => a.userId)));
  const startAt = existing?.startAt || new Date().toISOString();
  const endAt = existing?.endAt || new Date(Date.now() + 3600000).toISOString();

  const toggle = (id) => {
    const next = new Set(assignees);
    next.has(id) ? next.delete(id) : next.add(id);
    setAssignees(next);
  };

  const save = async () => {
    if (!title.trim()) return Alert.alert('Title required');
    const payload = { title, location, description, startAt, endAt, recurrence, category, provider, assigneeIds: [...assignees] };
    try {
      let result;
      if (existing) {
        result = await Api.updateEvent(existing.masterId || existing.id, { ...payload, version: existing.version });
      } else {
        result = await Api.createEvent(familyId, payload);
      }
      if (result.offline) {
        Alert.alert('Saved offline', 'No connection — this change is queued and will sync automatically once you are back online.');
      } else if (result.conflict) {
        Alert.alert('Synced with conflict resolution', `Fields merged: ${result.conflictFields?.join(', ') || 'none'}`);
      } else {
        await scheduleEventReminder(result.event || { ...payload }, 60).catch(() => {});
      }
      onSaved();
      onClose();
    } catch (e) {
      Alert.alert('Error', e.message);
    }
  };

  const remove = async () => {
    if (!existing) return;
    try {
      const result = await Api.deleteEvent(existing.masterId || existing.id);
      if (result.offline) Alert.alert('Queued offline', 'This deletion will sync once you are back online.');
      onSaved();
      onClose();
    } catch (e) {
      Alert.alert('Error', e.message);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 20, paddingTop: 56 }}>
        <Text style={styles.heading}>{existing ? 'Edit event' : 'New event'}</Text>

        <Text style={styles.label}>Title</Text>
        <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="e.g. Soccer Practice" />

        <Text style={styles.label}>Type</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
          {[{ key: 'general', label: 'General event' }, { key: 'appointment', label: 'Appointment / occasion' }].map((c) => (
            <TouchableOpacity key={c.key} onPress={() => setCategory(c.key)} style={[styles.pill, category === c.key && styles.pillActive]}>
              <Text style={[styles.pillText, category === c.key && styles.pillTextActive]}>{c.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        {category === 'appointment' && (
          <>
            <Text style={styles.label}>Provider / occasion detail (optional)</Text>
            <TextInput style={styles.input} value={provider} onChangeText={setProvider}
              placeholder="e.g. Dr. Patel — Pediatrics, or leave blank for birthdays/graduations" />
          </>
        )}

        <Text style={styles.label}>Location</Text>
        <TextInput style={styles.input} value={location} onChangeText={setLocation} placeholder="e.g. Riverside Field" />

        <Text style={styles.label}>Description</Text>
        <TextInput style={[styles.input, { height: 70 }]} value={description} onChangeText={setDescription} multiline />

        <Text style={styles.label}>Recurrence</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
          {['none', 'daily', 'weekly', 'monthly'].map((r) => (
            <TouchableOpacity key={r} onPress={() => setRecurrence(r)} style={[styles.pill, recurrence === r && styles.pillActive]}>
              <Text style={[styles.pillText, recurrence === r && styles.pillTextActive]}>{r}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.label}>Assign to</Text>
        {members.map((m) => (
          <TouchableOpacity key={m.id} style={styles.memberRow} onPress={() => toggle(m.id)}>
            <Switch value={assignees.has(m.id)} onValueChange={() => toggle(m.id)} />
            <View style={[styles.avatar, { backgroundColor: m.avatarColor }]}><Text style={styles.avatarText}>{initials(m.name)}</Text></View>
            <Text>{m.name}</Text>
          </TouchableOpacity>
        ))}

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 24 }}>
          {existing && (
            <TouchableOpacity style={[styles.btn, { backgroundColor: colors.red }]} onPress={remove}>
              <Text style={styles.btnText}>Delete</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={[styles.btn, { backgroundColor: colors.border, flex: 0 }]} onPress={onClose}>
            <Text style={[styles.btnText, { color: colors.text }]}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btn, { backgroundColor: colors.primary, flex: 1 }]} onPress={save}>
            <Text style={styles.btnText}>{existing ? 'Save changes' : 'Create event'}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 20, fontWeight: '800', marginBottom: 16 },
  label: { fontSize: 12, fontWeight: '700', color: colors.muted, marginBottom: 6, marginTop: 10 },
  input: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, fontSize: 14 },
  pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  pillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  pillText: { fontSize: 12, color: colors.text },
  pillTextActive: { color: 'white', fontWeight: '700' },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  avatar: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: 'white', fontSize: 11, fontWeight: '700' },
  btn: { paddingVertical: 12, borderRadius: 10, alignItems: 'center', paddingHorizontal: 16 },
  btnText: { color: 'white', fontWeight: '700' },
});
