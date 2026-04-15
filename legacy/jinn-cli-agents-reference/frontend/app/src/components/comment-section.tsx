'use client';

import { useState, useEffect } from 'react';
import { MessageSquare, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { postComment, getComments, type Comment } from '@/app/actions';
import { usePrivy } from '@privy-io/react-auth';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';

interface CommentSectionProps {
    ventureId: string;
}

export function CommentSection({ ventureId }: CommentSectionProps) {
    const { user, authenticated } = usePrivy();
    const [comments, setComments] = useState<Comment[]>([]);
    const [newComment, setNewComment] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isLoading, setIsLoading] = useState(true);

    // Fetch comments
    useEffect(() => {
        getComments(ventureId)
            .then(setComments)
            .catch((err) => {
                console.warn('Failed to fetch comments (likes/comments tables might be missing):', err);
                setComments([]);
            })
            .finally(() => setIsLoading(false));
    }, [ventureId]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newComment.trim()) return;

        if (!authenticated || !user?.wallet?.address) {
            toast.error('Please sign in to comment');
            return;
        }

        setIsSubmitting(true);

        // Optimistic update
        const optimisticComment: Comment = {
            id: crypto.randomUUID(),
            venture_id: ventureId,
            user_address: user.wallet.address,
            content: newComment,
            created_at: new Date().toISOString(),
        };

        setComments(prev => [optimisticComment, ...prev]);
        const commentText = newComment;
        setNewComment('');

        try {
            const result = await postComment(ventureId, user.wallet.address, commentText);
            if (result.error) throw new Error(result.error);

            // Replace optimistic comment with real one
            if (result.data) {
                setComments(prev => prev.map(c => c.id === optimisticComment.id ? result.data! : c));
            }
        } catch (error) {
            // Revert if failed
            setComments(prev => prev.filter(c => c.id !== optimisticComment.id));
            setNewComment(commentText);
            toast.error('Failed to post comment');
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-2 text-lg font-semibold">
                <MessageSquare className="h-5 w-5" />
                <h3>Comments ({comments.length})</h3>
            </div>

            {authenticated ? (
                <form onSubmit={handleSubmit} className="flex gap-4">
                    <Avatar className="h-10 w-10 border border-border/50">
                        <AvatarFallback>{user?.wallet?.address?.slice(0, 2)}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 space-y-2">
                        <Textarea
                            placeholder="What do you think?"
                            value={newComment}
                            onChange={(e) => setNewComment(e.target.value)}
                            className="resize-none min-h-[80px] bg-secondary/50 border-border/50 focus:bg-background transition-colors"
                        />
                        <div className="flex justify-end">
                            <Button type="submit" disabled={isSubmitting || !newComment.trim()} size="sm">
                                {isSubmitting ? 'Posting...' : 'Post Comment'}
                                <Send className="h-3 w-3 ml-2" />
                            </Button>
                        </div>
                    </div>
                </form>
            ) : (
                <div className="p-4 rounded-lg bg-secondary/30 border border-border/50 text-center text-sm text-muted-foreground">
                    Please sign in to join the discussion.
                </div>
            )}

            <div className="space-y-4">
                {isLoading ? (
                    <div className="text-center py-8 text-muted-foreground animate-pulse">Loading comments...</div>
                ) : comments.length > 0 ? (
                    comments.map((comment) => (
                        <div key={comment.id} className="flex gap-4 group">
                            <Avatar className="h-8 w-8 border border-border/30">
                                <AvatarFallback className="text-xs bg-secondary/50">
                                    {comment.user_address.slice(0, 2)}
                                </AvatarFallback>
                            </Avatar>
                            <div className="flex-1 space-y-1">
                                <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium text-foreground/80">
                                        {comment.user_address.slice(0, 6)}...{comment.user_address.slice(-4)}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                        {formatDistanceToNow(new Date(comment.created_at), { addSuffix: true })}
                                    </span>
                                </div>
                                <p className="text-sm text-muted-foreground leading-relaxed group-hover:text-foreground transition-colors">
                                    {comment.content}
                                </p>
                            </div>
                        </div>
                    ))
                ) : (
                    <div className="text-center py-8 text-muted-foreground italic">
                        No comments yet. Be the first to share your thoughts!
                    </div>
                )}
            </div>
        </div>
    );
}
